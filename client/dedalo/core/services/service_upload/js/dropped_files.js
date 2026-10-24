// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global console */
/*eslint no-undef: "error"*/



/**
* DROPPED_FILES
* Turns a browser `DataTransfer` (a drop or a paste) into a flat list of `File`
* objects, DESCENDING INTO DROPPED DIRECTORIES.
*
* This is the one genuinely hard piece of browser compatibility that the upload
* subsystem owns instead of delegating to a framework. Directory drop is a hard
* requirement: curators drop `scans/box1/` with hundreds of TIFFs, not files one
* by one. There is no standard, promise-shaped API for it — only the legacy
* `webkitGetAsEntry()` / `FileSystemDirectoryReader` pair, whose contract is
* full of traps that all fail SILENTLY (a partial ingest, never an error).
*
* THE THREE TRAPS THIS MODULE EXISTS TO NEUTRALISE
*
* 1. (!) `readEntries()` MUST BE CALLED REPEATEDLY UNTIL IT ANSWERS AN EMPTY
*        ARRAY. Browsers cap ONE call at an implementation-defined batch
*        (~100 entries in Chromium). A single call on a folder of 400 scans
*        returns 100 of them and NO error whatsoever: the curator sees a
*        successful ingest that is missing three quarters of the box. This is
*        the highest-value line of code in the file — see `read_all_entries`.
*
* 2. (!) `webkitGetAsEntry()` MUST BE CALLED SYNCHRONOUSLY, inside the drop
*        handler's own turn. The `DataTransferItemList` is neutered as soon as
*        the event handler returns, so the very common shape
*        `for (const item of items) { await something; item.webkitGetAsEntry() }`
*        yields null for every item after the first await — i.e. an empty drop.
*        `collect_roots` therefore does a purely SYNCHRONOUS first pass and the
*        traversal only starts once every root is already in hand.
*
* 3. (!) ONE UNREADABLE ENTRY MUST NOT SINK THE OTHERS, AND MUST NOT VANISH.
*        A permission error, a dangling symlink or a file deleted between the
*        drop and the read makes `entry.file()` / `readEntries()` invoke their
*        ERROR callback and nothing else. Swallowing it (what the reference
*        implementation does — it `console.log`s and returns) drops a file from
*        a heritage ingest with no trace. Every failure here is collected and
*        surfaced: per-failure through `options.on_error`, and in bulk on the
*        returned array's non-enumerable `errors` property.
*
* LIMITS (stated, never silent — AGENTS.md "never silently narrow scope"). Every
* one of them, when hit, pushes an error entry describing exactly what was cut:
*   - `max_depth`        32     directory levels below each dropped root.
*   - `max_files`        20000  files returned in total.
*   - `max_entries`      50000  directory entries examined in total.
*   - `max_read_calls`   2000   `readEntries()` calls for a SINGLE directory —
*                               a cycle guard for a reader that never empties.
*   - a PER-ROOT `Set` of already-visited directories, so a directory an engine
*     re-serves under one identity terminates instead of spinning.
*
* (!) THE VISITED SET IS PER DROPPED ROOT, AND KEYED ON THE FILESYSTEM.
* It used to be ONE set for the whole drop, keyed on `fullPath` alone. Chrome
* gives every dropped root `fullPath = '/' + name`, so dropping `boxA/scans` and
* `boxB/scans` together made the SECOND ROOT a "cycle": hundreds of scans were
* discarded whole, and the only trace was one line saying a single item could not
* be read. Scoping the set per root removes the collision by construction; the
* filesystem id in the key removes it again for any engine that hands two roots
* to one traversal.
* Stated honestly (AGENTS.md — never silently narrow scope): this guard is NOT
* what makes a genuine symlink loop terminate. No engine resolves the link, so
* `a/b → a` yields a strictly GROWING `fullPath` (`/a`, `/a/b`, `/a/b/a`, …) and
* no identity ever repeats. `max_depth` and `max_entries` are the real
* terminators, and both report what they cut.
*
* Main export:
* - `files_from_drop(data_transfer, options)` → `Promise<File[]>`
*/

// constants
	// Defaults for the traversal budget. All overridable per call so a caller with
	// a genuinely larger ingest can raise them EXPLICITLY rather than discover the
	// cap as a missing-files bug.
	const DEFAULT_MAX_DEPTH			= 32
	const DEFAULT_MAX_FILES			= 20000
	const DEFAULT_MAX_ENTRIES		= 50000
	const DEFAULT_MAX_READ_CALLS	= 2000

	/**
	* TRUNCATING_CODES
	* Every failure code this module can record — and every one of them means
	* ENTRIES WERE LOST.
	*
	* (!) `truncated` used to be derived from the two BUDGET flags alone, so a
	* folder whose reader failed on its third batch answered `files:200,
	* truncated:false` — a silently partial ingest that contradicted this
	* module's own contract and is not noticed until an audit years later. A
	* failure here is never cosmetic: `read_error` and `read_calls_limit` cut a
	* directory mid-enumeration, `depth_limit` and `cycle` drop a whole subtree,
	* `entry_error` drops one file, the two `*_limit` codes stop the walk.
	* Listing them (rather than testing `errors.length > 0`) is what makes a NEW
	* code a deliberate decision: add it here, or state next to it why the list
	* it returns is still complete.
	*/
	const TRUNCATING_CODES = new Set([
		'entry_limit', 'file_limit', 'read_error', 'read_calls_limit',
		'depth_limit', 'entry_error', 'cycle'
	])



/**
* ADD_ERROR
* Records ONE skipped entry and notifies the caller immediately.
*
* Immediate notification matters: a 900-file folder takes seconds to walk and a
* renderer that can only learn about failures at the end shows nothing while the
* user waits.
*
* @param {Object} state - The traversal state (holds `errors` and `on_error`).
* @param {string} code - Machine-readable reason (see the module header).
* @param {string} path - The relative path of the entry that was skipped.
* @param {*} [detail] - The original DOMException / Error, when there was one.
* @returns {void}
*/
const add_error = function(state, code, path, detail) {

	const error_info = {
		code	: code,
		path	: path,
		message	: (detail && detail.message)
			? detail.message
			: String(detail || code)
	}
	state.errors.push(error_info)

	if (typeof state.on_error === 'function') {
		try {
			state.on_error(error_info)
		} catch (error) {
			// The callback belongs to the caller's layer. A throw there must not
			// abort a traversal that is otherwise going fine.
			console.error('dropped_files on_error callback failed:', error)
		}
	}
}//end add_error



/**
* ATTACH_RELATIVE_PATH
* Stamps the entry's path within the dropped folder onto the File.
*
* (!) THIS MUTATES THE `File`. There is no clean alternative: `webkitRelativePath`
* is a read-only accessor on File.prototype, a wrapper object cannot be handed to
* `FormData.append` in its place, and re-constructing (`new File([file], …)`) both
* loses `lastModified` fidelity and forces a copy of a possibly multi-GB blob.
* The reference implementation mutates too (`file.fullPath = …`). We use
* `defineProperty` with `enumerable:false` so the added key can never leak into a
* `JSON.stringify` or an `Object.assign` of the file, and we tolerate failure:
* provenance is valuable, but never at the price of losing the file itself.
*
* @param {File} file
* @param {string} relative_path - e.g. `scans/box1/img.tif`.
* @returns {void}
*/
const attach_relative_path = function(file, relative_path) {

	if (!relative_path) {
		return
	}
	try {
		Object.defineProperty(file, 'dedalo_relative_path', {
			value			: relative_path,
			enumerable		: false,
			configurable	: true,
			writable		: true
		})
	} catch (error) {
		// A frozen/sealed File (no engine does this today) simply keeps no
		// provenance. Not worth failing the drop over.
		console.error('dropped_files could not attach the relative path:', error)
	}
}//end attach_relative_path



/**
* ENTRY_TO_FILE
* Promise wrapper around `FileSystemFileEntry.file(success, error)`.
* NEVER rejects — it resolves `{ok:false, error}` so one unreadable file inside a
* 900-file folder cannot reject the whole traversal (which is the failure mode
* that loses the other 899).
*
* @param {Object} entry - A FileSystemFileEntry.
* @returns {Promise<Object>} `{ok:true, file}` | `{ok:false, error}`.
*/
const entry_to_file = function(entry) {

	return new Promise(function(resolve) {
		try {
			entry.file(
				function(file) {
					resolve({ ok:true, file:file })
				},
				function(error) {
					resolve({ ok:false, error:error })
				}
			)
		} catch (error) {
			// Some engines throw synchronously on a revoked entry.
			resolve({ ok:false, error:error })
		}
	})
}//end entry_to_file



/**
* READ_ALL_ENTRIES
* Reads a directory COMPLETELY.
*
* (!) THE POINT OF THIS FUNCTION. `FileSystemDirectoryReader.readEntries` is
* specified to return "the next batch" — never necessarily all of it. Chromium
* answers at most ~100 entries per call and then, on the NEXT call, the rest;
* the enumeration is finished only when a call answers an EMPTY array. Calling
* it once (the intuitive reading of the API) truncates every folder over ~100
* files with no error, no warning and no way for the user to notice short of
* counting rows. If this loop regresses, large ingests silently lose files.
*
* The `max_read_calls` budget is the cycle guard for the opposite failure: a
* reader that keeps answering non-empty forever would loop until the tab dies.
*
* @param {Object} reader - A FileSystemDirectoryReader.
* @param {string} path - Relative path of the directory (for error reporting).
* @param {Object} state - Traversal state.
* @returns {Promise<Array<Object>>} Every entry of the directory (may be partial
*   when a read failed or the budget ran out — always with an `errors` entry).
*/
const read_all_entries = function(reader, path, state) {

	return new Promise(function(resolve) {

		const collected	= []
		let read_calls	= 0

		const read_next = function() {

			read_calls++
			if (read_calls > state.max_read_calls) {
				add_error(state, 'read_calls_limit', path,
					'Directory reader did not terminate after ' + state.max_read_calls + ' readEntries() calls')
				resolve(collected)
				return
			}

			let called_back = false
			try {
				reader.readEntries(
					function(entries) {
						if (called_back) {
							return
						}
						called_back = true
						// The EMPTY array — and ONLY the empty array — means "done".
						if (!entries || entries.length === 0) {
							resolve(collected)
							return
						}
						for (let i = 0; i < entries.length; i++) {
							collected.push(entries[i])
						}
						// Re-call. See the block comment: this is the whole reason
						// the function exists.
						read_next()
					},
					function(error) {
						if (called_back) {
							return
						}
						called_back = true
						add_error(state, 'read_error', path, error)
						// Resolve with WHAT WE HAVE: a directory that fails on its
						// third batch still yields its first two, and the failure is
						// reported rather than silently turning into a short list.
						resolve(collected)
					}
				)
			} catch (error) {
				if (called_back) {
					return
				}
				called_back = true
				add_error(state, 'read_error', path, error)
				resolve(collected)
			}
		}

		read_next()
	})
}//end read_all_entries



/**
* FILESYSTEM_ID
* A stable short id for the `FileSystem` an entry belongs to, '' when the engine
* exposes none.
*
* Identity is by OBJECT, not by `filesystem.name`: Chrome mints one isolated
* filesystem per dropped item and their names are not guaranteed to differ.
*
* @param {Object} state - Traversal state (owns the id table).
* @param {Object} entry - A FileSystemEntry.
* @returns {string}
*/
const filesystem_id = function(state, entry) {

	const filesystem = entry ? entry.filesystem : null
	if (!filesystem) {
		return ''
	}

	let id = state.filesystem_ids.get(filesystem)
	if (id === undefined) {
		id = 'fs' + state.filesystem_ids.size
		state.filesystem_ids.set(filesystem, id)
	}

	return id
}//end filesystem_id



/**
* WALK_ENTRY
* Depth-first traversal of one FileSystemEntry, appending files to `state.files`.
*
* @param {Object} entry - FileSystemFileEntry or FileSystemDirectoryEntry.
* @param {string} path - Relative path of this entry (`scans/box1/img.tif`).
* @param {number} depth - 0 for a dropped root.
* @param {Object} state - Traversal state.
* @returns {Promise<void>} Always resolves; failures land in `state.errors`.
*/
const walk_entry = async function(entry, path, depth, state) {

	// budgets. Checked BEFORE any work so the caller is told what was cut instead
	// of receiving a quietly short list.
		state.entries_seen++
		if (state.entries_seen > state.max_entries) {
			if (!state.entries_limit_reported) {
				state.entries_limit_reported = true
				add_error(state, 'entry_limit', path,
					'Stopped after examining ' + state.max_entries + ' entries')
			}
			return
		}
		if (state.files.length >= state.max_files) {
			if (!state.files_limit_reported) {
				state.files_limit_reported = true
				add_error(state, 'file_limit', path,
					'Stopped after collecting ' + state.max_files + ' files')
			}
			return
		}

	// file
		if (entry.isFile) {
			const outcome = await entry_to_file(entry)
			if (!outcome.ok) {
				// Permission denied, dangling symlink, file removed between the drop
				// and the read. Skip THIS entry, keep the rest, report it.
				add_error(state, 'entry_error', path, outcome.error)
				return
			}
			attach_relative_path(outcome.file, path)
			state.files.push(outcome.file)
			return
		}

	// directory
		if (!entry.isDirectory) {
			// Neither file nor directory: the spec allows nothing else, but a
			// non-conforming engine must be reported, not assumed away.
			add_error(state, 'entry_error', path, 'Entry is neither a file nor a directory')
			return
		}

		if (depth >= state.max_depth) {
			add_error(state, 'depth_limit', path,
				'Directory nesting deeper than ' + state.max_depth + ' levels was not traversed')
			return
		}

		// Cycle guard. See the module header for what it does and does NOT catch.
		// The set is the CURRENT ROOT's (`state.visited_directories` is replaced
		// per root), and the key carries the filesystem the entry came from so two
		// roots can never alias each other on the identical `fullPath` Chrome hands
		// every dropped item. `path` is only a fallback: a traversal path grows
		// monotonically and can never repeat, so it identifies nothing on its own.
		const identity = filesystem_id(state, entry) + '\u0000' + (entry.fullPath || path)
		if (state.visited_directories.has(identity)) {
			add_error(state, 'cycle', path, 'Directory already visited (symlink loop?)')
			return
		}
		state.visited_directories.add(identity)

		let reader = null
		try {
			reader = entry.createReader()
		} catch (error) {
			add_error(state, 'read_error', path, error)
			return
		}

		const children = await read_all_entries(reader, path, state)
		for (let i = 0; i < children.length; i++) {
			const child = children[i]
			await walk_entry(child, path + '/' + child.name, depth + 1, state)
		}
}//end walk_entry



/**
* COLLECT_ROOTS
* SYNCHRONOUS first pass over the DataTransfer.
*
* (!) Nothing here may await. `DataTransferItemList` and its items are only valid
* during the drop event's own turn — after the first await `webkitGetAsEntry()`
* answers null for every remaining item, which presents as "the drop was empty"
* or "only the first folder came through". Every root is captured here, and the
* async traversal runs afterwards on the captured FileSystemEntry objects (those
* DO stay valid).
*
* @param {Object} data_transfer
* @returns {Object} `{roots:Array, used_entries:boolean}` where a root is
*   `{kind:'entry', entry}` or `{kind:'file', file}`.
*/
const collect_roots = function(data_transfer) {

	const roots	= []
	const items	= data_transfer ? data_transfer.items : null

	// Directory-capable path. `webkitGetAsEntry` is the only feature test that
	// matters: every engine that has it also has createReader/readEntries.
	if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
		for (let i = 0; i < items.length; i++) {
			const item = items[i]
			// A drop can carry non-file items (a dragged text selection, a URL).
			// `kind` is the discriminator; treat an absent kind as a file, exactly
			// as the reference implementation does.
			if (item.kind && item.kind !== 'file') {
				continue
			}
			let entry = null
			try {
				entry = item.webkitGetAsEntry()
			} catch (error) {
				entry = null
			}
			if (entry) {
				roots.push({ kind:'entry', entry:entry })
				continue
			}
			// No entry (an engine quirk, or a synthetic DataTransfer): fall back to
			// the plain File for THIS item only — losing a file because the entry
			// API blinked is not acceptable.
			if (typeof item.getAsFile === 'function') {
				const file = item.getAsFile()
				if (file) {
					roots.push({ kind:'file', file:file })
				}
			}
		}
		if (roots.length > 0) {
			return { roots:roots, used_entries:true }
		}
	}

	// Fallback: no entry API at all (or it yielded nothing). `data_transfer.files`
	// is a FileList — plain files only; a folder dropped here is simply not
	// enumerable by the browser and shows up as an unreadable zero-byte entry,
	// which is the platform's behaviour, not ours to invent around.
	const files = data_transfer ? data_transfer.files : null
	if (files) {
		for (let i = 0; i < files.length; i++) {
			roots.push({ kind:'file', file:files[i] })
		}
	}

	return { roots:roots, used_entries:false }
}//end collect_roots



/**
* FILES_FROM_DROP
* The module's one export: a `DataTransfer` in, a flat `File[]` out, with every
* dropped directory walked to the bottom.
*
* The returned array carries two NON-ENUMERABLE properties, so it still behaves
* exactly like a `File[]` for iteration, spread and `JSON.stringify`:
*   - `errors`    {Array<{code,path,message}>} every entry that was skipped.
*   - `truncated` {boolean} true when the list is INCOMPLETE — a budget was hit,
*     a directory could not be finished, or an entry could not be read. It is
*     NOT a count: how many files a failed directory read cost is unknowable, so
*     a caller must say "an unknown number is missing", never "N are missing".
* A caller that only wants the files can ignore both; a caller that must not lose
* a scan silently reads `errors` and tells the user. `options.on_error` reports
* the same failures one at a time, as they happen.
*
* @param {Object} data_transfer - `event.dataTransfer` (or a clipboard equivalent).
* @param {Object} [options]
*   @param {Function} [options.on_error] - Called once per skipped entry with
*     `{code, path, message}`.
*   @param {number} [options.max_depth=32]
*   @param {number} [options.max_files=20000]
*   @param {number} [options.max_entries=50000]
*   @param {number} [options.max_read_calls=2000] - Per single directory.
* @returns {Promise<Array<File>>} Never rejects: an unreadable drop is an empty
*   list plus a populated `errors`, because a rejected promise here would take
*   the whole ingest down for one bad symlink.
*/
export const files_from_drop = async function(data_transfer, options) {

	// options
		const config = options || {}

	// state
		const state = {
			files					: [],
			errors					: [],
			on_error				: config.on_error,
			max_depth				: typeof config.max_depth === 'number' ? config.max_depth : DEFAULT_MAX_DEPTH,
			max_files				: typeof config.max_files === 'number' ? config.max_files : DEFAULT_MAX_FILES,
			max_entries				: typeof config.max_entries === 'number' ? config.max_entries : DEFAULT_MAX_ENTRIES,
			max_read_calls			: typeof config.max_read_calls === 'number' ? config.max_read_calls : DEFAULT_MAX_READ_CALLS,
			entries_seen			: 0,
			// Replaced per dropped root — see the module header.
			visited_directories		: new Set(),
			filesystem_ids			: new Map(),
			entries_limit_reported	: false,
			files_limit_reported	: false
		}

	// roots. SYNCHRONOUS — see collect_roots.
		const collected = collect_roots(data_transfer)

	// traversal
		for (let i = 0; i < collected.roots.length; i++) {
			const root = collected.roots[i]
			if (root.kind === 'entry') {
				// (!) A FRESH SET PER ROOT. Chrome gives every dropped root
				// `fullPath = '/' + name`, so one shared set made the second of two
				// same-named folders (`boxA/scans`, `boxB/scans`) a "cycle" and
				// discarded it whole.
				state.visited_directories = new Set()
				await walk_entry(root.entry, root.entry.name, 0, state)
				continue
			}
			// A plain File. `webkitRelativePath` is populated by a directory
			// <input webkitdirectory>; when present it IS the provenance and must
			// not be overwritten by the bare name.
			state.entries_seen++
			if (state.files.length >= state.max_files) {
				if (!state.files_limit_reported) {
					state.files_limit_reported = true
					add_error(state, 'file_limit', root.file.name,
						'Stopped after collecting ' + state.max_files + ' files')
				}
				continue
			}
			if (root.file.webkitRelativePath) {
				attach_relative_path(root.file, root.file.webkitRelativePath)
			}
			state.files.push(root.file)
		}

	// result. The two diagnostics ride along non-enumerably so the value is still
	// a plain array of Files for every ordinary use.
		const result = state.files
		Object.defineProperty(result, 'errors', {
			value			: state.errors,
			enumerable		: false,
			configurable	: true,
			writable		: true
		})
		// (!) TRUNCATED IS EVERY TRUNCATING FAILURE, not just the two budgets. See
		// TRUNCATING_CODES: a read that died on its third batch, a subtree cut by
		// the depth guard and a file the OS refused all shorten the list exactly as
		// a budget does, and each of them used to answer `truncated:false`.
		Object.defineProperty(result, 'truncated', {
			value			: state.errors.some(function(error_info){
				return TRUNCATING_CODES.has(error_info.code)
			}),
			enumerable		: false,
			configurable	: true,
			writable		: true
		})


	return result
}//end files_from_drop



// @license-end
