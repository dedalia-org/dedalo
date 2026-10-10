// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL, DEDALO_API_URL */
/*eslint no-undef: "error"*/



/**
* RENDER_AREA_MAINTENANCE
* Client-side rendering layer for the Dédalo maintenance area (area_maintenance).
*
* This module is responsible for the visual shell of the administrator dashboard.
* It is paired with `area_maintenance.js` (which owns the lifecycle: init / build /
* render / refresh / destroy) and with the server-side `class.area_maintenance.php`
* (which produces the widget datalist consumed here).
*
* Architecture overview
* ---------------------
* The server delivers a flat `datalist` array of widget descriptor objects via the
* standard Dédalo JSON API.  Each descriptor carries:
*   - `id`       {string}  widget identifier — also the ES-module filename and
*                          exported constructor name (e.g. `"make_backup"`).
*   - `label`    {string}  HTML display label supplied by `class.area_maintenance.php`.
*   - `category` {string}  bucket key matching one of the entries in `get_category_defs()`
*                          (e.g. `"data"`, `"migration"`, `"config"`, …).
*   - `class`    {string}  optional extra CSS class on the card (e.g. `"success"`).
*   - `background` {boolean} optional flag; when true the widget loads at idle priority
*                          even before the user opens the card accordion.
*   - `value`    {*}       optional widget-specific payload forwarded to `widget.init()`.
*
* Dashboard layout (introduced in maintenance_v2)
* -----------------------------------------------
* `get_content_data()` builds a two-level layout:
*   1. Sticky toolbar — live text search + category chip filters.
*   2. Category groups — one `<div class="maintenance_group">` per non-empty category,
*      each containing a labelled header and a grid of collapsible widget cards.
*
* Widget cards are individually lazy-loaded via `render_widget()`, which:
*   - Dynamically imports the widget ES module from `../widgets/<id>/js/<id>.js`.
*   - Runs the standard init → build → render lifecycle.
*   - Defers the `load()` call (data fetch) until the user opens the accordion,
*     except for "background" widgets which load at idle priority immediately.
*   - Persists the open/closed state of each card via `ui.collapse_toggle_track`.
*
* Public exports
* --------------
*   render_area_maintenance  — prototype constructor; `edit` and `list` prototypes
*                              are assigned onto `area_maintenance` in area_maintenance.js.
*   print_response           — formats and injects an API response object into a DOM node.
*   build_form               — generic widget form builder (inputs + submit + API call).
*   set_widget_label_style   — adds/removes a CSS class on the outer widget card.
*
* Server peer:  core/area_maintenance/class.area_maintenance.php
* Lifecycle:    area_maintenance.js (init / build / render / refresh / destroy)
* API:          dd_area_maintenance_api (action `get_data` → datalist)
*/

// imports
	import {when_in_dom, dd_request_idle_callback} from '../../common/js/events.js'
	import {append_text_lines} from '../../common/js/utils/index.js'
	import {data_manager} from '../../common/js/data_manager.js'
	import {render_tree_data, format_label} from '../../common/js/common.js'
	import {ui} from '../../common/js/ui.js'
	import {widget_common} from '../../widgets/widget_common/js/widget_common.js'
	import {request_failed, response_data, response_extension} from '../../common/js/api_error.js'
	import {error_text} from '../../common/js/render_api_error.js'
	import {OPEN_WIDGET_EVENT} from './maintenance_events.js'



/**
* ENGINE_DISABLED_WIDGETS
* Widget ids that the current server engine cannot serve and that must NOT be
* rendered in the dashboard. Kept here (client-side) rather than removed from the
* server widget catalog so the catalog stays byte-identical to the PHP oracle
* (the differential parity gate compares every catalog entry).
*
* Empty since 2026-07-15 (WC-030): the last entry, php_info (a phpinfo()
* iframe with no Bun equivalent), was merged into the TS-native runtime_info
* widget (formerly php_runtime) rather than kept as a denied stub — there is
* no PHP-only widget left to hide.
*/
	const ENGINE_DISABLED_WIDGETS = new Set([])



/**
* RENDER_AREA_MAINTENANCE
* Prototype constructor for the maintenance-area render module.
*
* This constructor is intentionally a no-op; all rendering logic lives in the
* prototype methods `edit` and `list` below.  The constructor exists so that
* `area_maintenance.js` can assign these prototype methods onto the
* `area_maintenance` prototype using the standard Dédalo prototype-assignment
* pattern:
*
*   area_maintenance.prototype.edit = render_area_maintenance.prototype.edit
*   area_maintenance.prototype.list = render_area_maintenance.prototype.list
*
* Never instantiate `render_area_maintenance` directly; always call through
* an `area_maintenance` instance.
*/
export const render_area_maintenance = function() {

	return true
}//end render_area_maintenance



/**
* EDIT
* Builds the main DOM tree for the maintenance area in edit mode.
*
* Delegates the actual widget-grid construction to `get_content_data()` and
* then wraps the result in the standard area wrapper produced by `ui.area.build_wrapper_edit`.
* The wrapper exposes `wrapper.content_data` as a direct reference so that
* subsequent refresh cycles can surgically replace just the inner grid without
* rebuilding the full shell.
*
* When `options.render_level === 'content'` only the raw `content_data` element
* is returned (no wrapper), which is the pattern used by `common.prototype.refresh`
* to efficiently swap content in place.
*
* @param {Object} options - Render options bag forwarded by the lifecycle caller
* @param {string} [options.render_level='full'] - 'full' returns the complete wrapper;
*   'content' returns the inner content_data element only (used by refresh)
* @returns {Promise<HTMLElement>} The area wrapper element (render_level='full') or
*   the raw content_data element (render_level='content')
*/
render_area_maintenance.prototype.edit = async function(options) {

	const self = this

	const render_level = options.render_level || 'full'

	// content_data
		const content_data = await get_content_data(self)
		if (render_level==='content') {
			return content_data
		}

	// wrapper. ui build_edit returns component wrapper
		const wrapper =	ui.area.build_wrapper_edit(self, {
			content_data : content_data
		})
		// set pointers
		wrapper.content_data = content_data


	return wrapper
}//end edit



/**
* LIST
* Alias of `edit`. The maintenance area has no dedicated list view; the full
* widget dashboard is rendered in both edit and list contexts.
*
* @param {Object} options - Forwarded verbatim to `this.edit(options)`
* @returns {Promise<HTMLElement>} Result of `this.edit(options)`
*/
render_area_maintenance.prototype.list = async function(options) {

	return this.edit(options)
}//end list



/**
* GET_CATEGORY_DEFS
* Returns the canonical ordered list of maintenance widget category definitions.
*
* Each entry drives two things in `get_content_data()`:
*   1. The order in which category sections appear in the dashboard grid.
*   2. The human-readable label rendered in the group header and in the
*      category chip filter button.
*
* The `key` value must match the `category` property that `class.area_maintenance.php`
* assigns to each widget descriptor in `get_ar_widgets()` / `widget_factory()`.
* Widgets whose descriptor lacks a `category` property fall into the `'general'` bucket.
*
* Labels are sourced from `get_label` (the application's i18n dictionary).  The
* `|| 'fallback'` ensures the UI still renders meaningfully when a label key is
* missing from the active language file.
*
* @returns {Array<{key: string, label: string}>} Ordered category definition objects
*/
const get_category_defs = function() {

	return [
		{ key:'data',		label: get_label.maintenance_cat_data		|| 'Backup & data' },
		{ key:'migration',	label: get_label.maintenance_cat_migration	|| 'Migration & transform' },
		{ key:'config',		label: get_label.maintenance_cat_config		|| 'Configuration & code' },
		{ key:'integrity',	label: get_label.maintenance_cat_integrity	|| 'Integrity & monitoring' },
		{ key:'system',		label: get_label.maintenance_cat_system		|| 'System & environment' },
		{ key:'diffusion',	label: get_label.maintenance_cat_diffusion	|| 'Diffusion' },
		{ key:'publication',label: get_label.maintenance_cat_publication	|| 'Publication' },
		{ key:'dev',		label: get_label.maintenance_cat_dev		|| 'Developer & testing' },
		{ key:'general',	label: get_label.others						|| 'Other' }
	]
}//end get_category_defs



/**
* GET_CONTENT_DATA
* Builds the complete maintenance dashboard DOM tree.
*
* The dashboard consists of three layers:
*
*   1. Sticky toolbar (`<div class="maintenance_toolbar">`)
*        - A text search input whose `input` event is debounced through
*          `dd_request_idle_callback` to avoid layout thrashing during fast typing.
*        - Category chip buttons (one "All" chip plus one per non-empty category),
*          rendered in the order defined by `get_category_defs()`.
*
*   2. Category groups (`<div class="maintenance_groups">`)
*        - One `<div class="maintenance_group">` per category that has at least one
*          widget in the `self.widgets` datalist.
*        - Each group has a header (icon placeholder + label + widget count) and a
*          CSS grid of widget cards (`<div class="group_grid">`).
*        - Cards are loaded asynchronously via `ui.load_item_with_spinner`, which
*          shows a spinner while `render_widget()` resolves.
*
*   3. Empty state (`<div class="maintenance_empty">`)
*        - Hidden by default; toggled visible by `apply_filters()` whenever no card
*          matches the current search + category combination.
*
* Filter model
* ------------
* Two mutable closure variables drive visibility:
*   - `active_category` — set by chip clicks; empty string means "show all".
*   - `search_term`     — lowercase trimmed value of the search input.
*
* `apply_filters()` is the single point of truth: it iterates `group_nodes` and
* each group's `.widget_container` cards, applying `classList.toggle('filtered_out', !show)`
* to hide non-matching cards, and `classList.toggle('hide', …)` to collapse entire
* groups when all their cards are hidden.
*
* Widget card data attributes
* ---------------------------
* Each `.widget_container` element carries `data-category` and `data-label` (lowercase)
* so that `apply_filters()` can match without touching the widget instances themselves.
*
* @param {Object} self - The `area_maintenance` instance; must have `self.widgets`
*   (the `datalist` array from the API response) and `self.type` (for CSS class)
* @returns {HTMLElement} The fully constructed `content_data` div, ready to be
*   appended to the area wrapper by `edit()`
*/
const get_content_data = async function(self) {

	// filter out widgets the current engine cannot serve (see ENGINE_DISABLED_WIDGETS)
		const widgets = (self.widgets || []).filter(
			widget => !ENGINE_DISABLED_WIDGETS.has(widget.id)
		)

	// content_data (host for both views: System Map + classic List accordion)
		const content_data = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'content_data maintenance_v2 ' + (self.type || '')
		})

	// persisted view choice ('map' | 'list'). Map is the default.
		const view_key = 'maintenance_view_' + (self.tipo || 'area_maintenance')
		let active_view = 'map'
		try {
			const saved = await data_manager.get_local_db_data(view_key, 'status', true)
			if (saved && (saved.value==='map' || saved.value==='list')) {
				active_view = saved.value
			}
		} catch (err) {
			console.warn('[area_maintenance] could not restore view selection', err)
		}

	// restore the last map selection (node|tool), so a reload / navigation returns
	// the user to the subsystem + tool they were on
		const sel_key = 'maintenance_map_sel_' + (self.tipo || 'area_maintenance')
		let saved_sel = null
		try {
			const s = await data_manager.get_local_db_data(sel_key, 'status', true)
			if (s && typeof s.value==='string' && s.value) {
				const [node, tool] = s.value.split('|')
				saved_sel = { node: node || null, tool: tool || null }
			}
		} catch (err) {
			console.warn('[area_maintenance] could not restore map selection', err)
		}

	// view switch (Map | List) + ⌘K launcher
		const view_switch = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'map_view_switch',
			parent			: content_data
		})
		const switch_group = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'map_switch',
			parent			: view_switch
		})
		const btn_map = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'map_switch_btn',
			inner_html		: get_label.maintenance_view_map || 'Map',
			parent			: switch_group
		})
		const btn_list = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'map_switch_btn',
			inner_html		: get_label.maintenance_view_list || 'List',
			parent			: switch_group
		})
		const kbar = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'map_kbar',
			inner_html		: (get_label.maintenance_find_tool || 'Find a tool') + ' <kbd>⌘K</kbd>',
			parent			: view_switch
		})

	// the two views
		const list_wrap = await build_list_view(self, widgets)
		content_data.appendChild(list_wrap)
		// show_map: an OPEN_WIDGET_EVENT from the list view switches to the map first
		// (set_view is declared below; the callback only runs on a later user click)
		const map_ctl = build_map_view(self, widgets, { sel_key, saved_sel, show_map: () => set_view('map', true) })
		// hand the map's teardown to the instance, which is what actually gets destroyed
		self.map_ctl = map_ctl
		content_data.appendChild(map_ctl.node)

	// apply + persist the active view
		const set_view = (view, persist) => {
			active_view = view
			content_data.classList.toggle('view_map', view==='map')
			content_data.classList.toggle('view_list', view==='list')
			btn_map.classList.toggle('active', view==='map')
			btn_list.classList.toggle('active', view==='list')
			kbar.style.display = (view==='map') ? '' : 'none'
			if (view==='map') {
				map_ctl.on_show()
			}
			if (persist) {
				try {
					data_manager.set_local_db_data({ id: view_key, value: view }, 'status')
				} catch (err) {
					console.warn('[area_maintenance] could not persist view selection', err)
				}
			}
			// (!) Announce the switch. Hiding the list view is a pure CSS class
			// flip — the widget nodes stay CONNECTED and no lifecycle callback
			// fires anywhere — so a widget holding a live resource cannot
			// otherwise tell that it just became invisible. An `isConnected`
			// check does not help here; visibility is the only signal, and this
			// event is it.
			document.dispatchEvent(new CustomEvent('dd_maintenance_view', { detail: { view } }))
		}
		btn_map.addEventListener('click', (e) => { e.preventDefault(); set_view('map', true) })
		btn_list.addEventListener('click', (e) => { e.preventDefault(); set_view('list', true) })
		kbar.addEventListener('click', (e) => { e.preventDefault(); map_ctl.open_palette() })
		set_view(active_view, false)


	return content_data
}//end get_content_data



/**
* BUILD_LIST_VIEW
* Builds the classic accordion dashboard (sticky toolbar with live search +
* category chips over category-grouped collapsible widget cards). This is the
* original `get_content_data` body, unchanged in behaviour, reparented under a
* `.list_view_wrap` node so it can coexist with the System Map view.
*
* @param {Object} self - The area_maintenance instance
* @param {Array}  widgets - The engine-served widget descriptors (already filtered)
* @returns {Promise<HTMLElement>} The `.list_view_wrap` node
*/
const build_list_view = async function(self, widgets) {

	// bucket widgets by category, preserving definition order within each bucket
		const buckets = {}
		for (let i = 0; i < widgets.length; i++) {
			const widget	= widgets[i]
			const cat		= widget.category || 'general'
			if (!buckets[cat]) {
				buckets[cat] = []
			}
			buckets[cat].push(widget)
		}

	// wrapper
		const list_wrap = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'list_view_wrap'
		})

	// persistence key for the last selected group chip (IndexedDB 'status' table)
		const persist_key = 'maintenance_active_category_' + (self.tipo || 'area_maintenance')

	// filter state. active_category is restored from local persistence BEFORE building
	// the DOM so the first paint is already filtered (no flash of all groups on load).
		let active_category	= '' // '' === all
		let search_term		= ''
		try {
			const saved = await data_manager.get_local_db_data(persist_key, 'status', true)
			// restore only if the saved category still has widgets (stale-value guard);
			// covers no-record (undefined), blocked IndexedDB (false) and default ('')
			if (saved && saved.value!=='' && buckets[saved.value] && buckets[saved.value].length) {
				active_category = saved.value
			}
		} catch (err) {
			console.warn('[area_maintenance] could not restore filter selection', err)
		}

	// toolbar (sticky)
		const toolbar = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'maintenance_toolbar',
			parent			: list_wrap
		})
		const search_wrap = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'maintenance_search_wrap',
			parent			: toolbar
		})
		const search_input = ui.create_dom_element({
			element_type	: 'input',
			type			: 'search',
			class_name		: 'maintenance_search dd_input',
			placeholder		: (get_label.search || 'Search') + '…',
			parent			: search_wrap
		})
		const filters = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'maintenance_filters',
			parent			: toolbar
		})

	// groups container
		const groups = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'maintenance_groups',
			parent			: list_wrap
		})

	// filter chips ('All' + one per non-empty category)
		const chips = []
		const make_chip = (key, label) => {
			const chip = ui.create_dom_element({
				element_type	: 'button',
				class_name		: 'maintenance_chip' + (key===active_category ? ' active' : ''),
				inner_html		: label,
				dataset			: { category: key },
				parent			: filters
			})
			chip.addEventListener('click', (e) => {
				e.preventDefault()
				active_category = key
				chips.forEach(c => { c.classList.toggle('active', c===chip) })
				apply_filters()
				// persist selection (fire-and-forget; default 'All' stores no record)
				try {
					if (key==='') {
						data_manager.delete_local_db_data(persist_key, 'status')
					} else {
						data_manager.set_local_db_data({ id: persist_key, value: key }, 'status')
					}
				} catch (err) {
					console.warn('[area_maintenance] could not persist filter selection', err)
				}
			})
			chips.push(chip)
		}
		make_chip('', get_label.all || 'All')

	// build one section per non-empty category, in defined order
		const category_defs	= get_category_defs()
		const group_nodes	= []
		for (let c = 0; c < category_defs.length; c++) {

			const def	= category_defs[c]
			const list	= buckets[def.key]
			if (!list || !list.length) {
				continue
			}

			make_chip(def.key, def.label)

			// group
			const group = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'maintenance_group',
				dataset			: { category: def.key },
				parent			: groups
			})

			// group header (icon + label + count)
			const header = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'group_header',
				parent			: group
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'group_icon',
				parent			: header
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'group_label',
				inner_html		: def.label,
				parent			: header
			})
			ui.create_dom_element({
				element_type	: 'span',
				class_name		: 'group_count',
				inner_html		: list.length,
				parent			: header
			})

			// grid of cards
			const grid = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'group_grid',
				parent			: group
			})

			for (let i = 0; i < list.length; i++) {

				const widget = list[i]

				// container (same structure/lifecycle as before; data-attrs added for filtering + category icon)
				const container = ui.create_dom_element({
					id				: widget.id,
					element_type	: 'div',
					dataset			: {
						category	: widget.category || 'general',
						label		: (widget.label || '').toLowerCase()
					},
					class_name		: 'widget_container ' + (widget.class || ''),
					parent			: grid
				})

				ui.load_item_with_spinner({
					container			: container,
					replace_container	: false,
					label				: (widget.label || '').replace(/<[^>]*>/g, ''),
					callback			: async () => {
						const node = await render_widget(widget, self)
						setTimeout(()=>{
							container.classList.add('loaded')
						}, 3)
						return node
					}
				})
			}

			group_nodes.push(group)
		}

	// empty state (shown when nothing matches the current filters)
		const empty_state = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'maintenance_empty hide',
			inner_html		: get_label.no_tools_match || 'No tools match your search',
			parent			: groups
		})

	// apply_filters. Combines active category chip + search term (AND)
		const apply_filters = () => {
			let any_visible = false
			for (let g = 0; g < group_nodes.length; g++) {

				const group		= group_nodes[g]
				const cat_ok	= !active_category || active_category===group.dataset.category

				let visible_in_group = 0
				const cards = group.querySelectorAll('.widget_container')
				for (let k = 0; k < cards.length; k++) {
					const card			= cards[k]
					const match_search	= !search_term || (card.dataset.label || '').includes(search_term)
					const show			= cat_ok && match_search
					card.classList.toggle('filtered_out', !show)
					if (show) {
						visible_in_group++
					}
				}

				group.classList.toggle('hide', visible_in_group===0)
				if (visible_in_group>0) {
					any_visible = true
				}
			}
			empty_state.classList.toggle('hide', any_visible)
		}

	// live search (debounced via idle callback)
		search_input.addEventListener('input', () => {
			dd_request_idle_callback(() => {
				search_term = search_input.value.trim().toLowerCase()
				apply_filters()
			})
		})

	// initial filter pass when a group was restored, so the first paint shows only the
	// saved category (active_category was already set before the DOM was built)
		if (active_category!=='') {
			apply_filters()
		}


	return list_wrap
}//end build_list_view



/**
* SYSTEM MAP — architecture model
* --------------------------------
* The map regroups the maintenance tools by WHAT THEY TOUCH (a subsystem node)
* rather than by the implementation taxonomy the List view uses. Each node lists
* the widget ids that act on it; a widget may appear under more than one node
* (e.g. make_backup touches both PostgreSQL and Backups). Positions are percent
* coordinates on the stage. Nothing here is load-bearing for correctness: every
* served widget is ALSO reachable from the ⌘K palette, so a mis-scoped or newly
* added id is never hidden — it simply also shows in the palette.
*/
	const MAP_NODES = [
		{ id:'clients',	title:'Clients',		x:10, y:14, tools:['lock_components'] },
		{ id:'web',		title:'Web server',		x:29, y:14, tools:['system_info','runtime_info','environment'] },
		{ id:'core',	title:'Dédalo core',	x:50, y:14, kind:'core',
			tools:['check_config','config_areas','menu_skip_tipos','update_code','serve_code','update_data_version','error_reports'] },
		// the tools/ package tree + its dd1324 registry records (matrix_tools) — a
		// subsystem of its own, not part of the engine core: register_tools reconciles
		// the two and touches nothing else.
		{ id:'tools',	title:'Tools',			x:71, y:14, tools:['register_tools'] },
		// developer surfaces: sandboxes that exercise the engine (API, SQO) or
		// provision a known-state fixture row. They act ON the engine, they are not
		// part of it — and unlike every other node, opening one is the whole point,
		// so this node is never probed (unit_test WRITES a matrix_test row).
		{ id:'dev',		title:'Dev & testing',	x:90, y:14,
			tools:['unit_test','dedalo_api_test_environment','sqo_test_environment'] },
		{ id:'pg',		title:'PostgreSQL',		x:12, y:66,
			tools:['database_info','counters_status','sequences_status','reconcile_status','dataframe_control','move_to_table','build_database_version','make_backup'] },
		{ id:'bak',		title:'Backups',		x:31, y:66, tools:['make_backup','build_database_version'] },
		{ id:'pub',		title:'Publication',	x:50, y:66, tools:['diffusion_server_control','publication_api','site_builder_status','publication_hosts'] },
		{ id:'media',	title:'Media store',	x:69, y:66, tools:['media_control','ai_models'] },
		{ id:'onto',	title:'Ontology',		x:88, y:66,
			tools:['update_ontology','serve_ontology','move_tld','move_locator','move_to_portal','move_lang','export_hierarchy','add_hierarchy'] }
	]
	const MAP_EDGES = [
		['clients','web'], ['web','core'], ['core','pg'], ['core','bak'],
		['core','pub'], ['core','media'], ['core','onto'], ['core','tools'],
		['core','dev','dim'],
		['pg','bak','dim'], ['pub','media','dim'], ['tools','onto','dim']
	]
	// irreversible / destructive tools — flagged red in the map (chips + palette)
	const MAP_DANGER_IDS = new Set([
		'update_ontology','update_code','update_data_version',
		'move_tld','move_locator','move_to_portal','move_lang','move_to_table'
	])
	// one-line "what this does" leads, shown above the mounted tool in the panel
	// body (the mockup's .lead). Purely descriptive — no data, so always honest.
	// The English here is the call-site FALLBACK; a tool listed in
	// MAP_TOOL_DESC_LABEL below serves its translated lead from the label
	// catalogs instead (WC-033). Translating the rest is the same two lines each.
	const MAP_TOOL_DESC = {
		system_info:				'Full server snapshot — OS, CPU, RAM, disk, uptime and prerequisites.',
		check_config:				'Audits the live install config: database status and private sources.',
		runtime_info:				'Bun engine runtime — version, pid, memory, uptime — plus cache and session pruning.',
		environment:				'Server environment snapshot.',
		register_tools:				'Imports tool register.json metadata into the ontology.',
		config_areas:				'Runtime allow / deny editor for areas.',
		menu_skip_tipos:			'Runtime override for menu grouping tipos.',
		unit_test:					'Provisions a known-state matrix_test row from a fixture.',
		dedalo_api_test_environment:'API endpoint testing sandbox.',
		sqo_test_environment:		'Search-query-object testing sandbox.',
		update_code:				'Downloads, verifies and installs a new code release, then restarts. The previous tree is kept as a restore point.',
		serve_code:					'Code server: builds releases from git and serves them to the installations that update from this one.',
		update_data_version:		'Runs pending data-version migrations against live data.',
		lock_components:			'Active user sessions and component-lock tracking.',
		database_info:				'Live PostgreSQL catalog snapshot and maintenance actions.',
		build_database_version:		'Builds a clean-slate database snapshot. Heavy but additive.',
		counters_status:			'Audit of the matrix_counter section-id counters.',
		sequences_status:			'PostgreSQL sequence-counter audit.',
		reconcile_status:			'Every cross-store reconcile in one place: check drift between two stores, apply the repair.',
		dataframe_control:			'Audit and repair dataframe locator pairing.',
		move_to_table:				'Migrates section records between matrix tables. Irreversible.',
		make_backup:				'Creates a compressed PostgreSQL dump in the backup directory.',
		diffusion_server_control:	'Native publication engine: status, job queue and scheduler.',
		publication_api:			'Diffusion API endpoint status and network probe.',
		site_builder_status:		'Agent-built public websites: daemon status and a launcher for the site builder.',
		publication_hosts:			'Separate publication machines: pairing, media rules and API releases. Hosts are paired on the command line.',
		media_control:				'Sets the media access-protection mode and rebuilds the gate rules.',
		ai_models:					'Local AI model store: which speech models are installed and usable.',
		update_ontology:			'Replaces the ontologies of the selected TLDs with a snapshot from a master server and re-processes them. Your local ontology is kept. Irreversible.',
		serve_ontology:				'Whether other installations can pull their ontology from this one: the three .env keys that decide it and the endpoint they register.',
		move_tld:					'Rewrites the ontology tipo across every matrix table. Irreversible.',
		move_locator:				'Bulk-moves locators from a source section to a target. Irreversible.',
		move_to_portal:				'Portalizes component data into a portal-linked sub-section.',
		move_lang:					'Migrates component data between translatable and non-translatable.',
		export_hierarchy:			'Exports thesaurus tables to gzipped COPY files.',
		add_hierarchy:				'Installs additional hierarchy packages.',
		error_reports:				'Browse and manage stored error reports.'
	}
	// tool id → label key, resolved at RENDER time (get_label is populated at boot,
	// after this module is imported, so a module-level read would serve undefined).
	const MAP_TOOL_DESC_LABEL = {
		update_code			: 'update_code_lead',
		update_ontology		: 'update_ontology_lead',
		publication_hosts	: 'publication_hosts_lead'
	}



/**
* BUILD_MAP_VIEW
* Builds the System Map view: a health-coloured topology of the running system.
* Clicking a subsystem node reveals its status and the tools scoped to it; the
* selected tool mounts the real widget module (same lifecycle as the List view)
* in the context panel. A ⌘K palette launches any served tool by name.
*
* Node health is honest, never faked:
*   - PostgreSQL and Publication are probed once at idle via the existing
*     get_widget_value API (cheap, read-only) and light up on load.
*   - Any node lights up when opened, mirroring the mounted widget's own health
*     verdict (the `danger`/`success` class it sets on its card).
*   - Every other node stays neutral until touched.
*
* Exported for the browser suite (test_publication_hosts: the OPEN_WIDGET_EVENT
* receive half); the area itself is its only production caller.
*
* @param {Object} self - The area_maintenance instance
* @param {Array}  widgets - The engine-served widget descriptors (already filtered)
* @returns {{node:HTMLElement, on_show:Function, open_palette:Function, open_tool:Function, destroy:Function}}
*/
export const build_map_view = function(self, widgets, opts={}) {

	// persist the current selection (node|tool) for restore on reload/navigation
		const persist_sel = (node, tool) => {
			if (!opts || !opts.sel_key) { return }
			try {
				data_manager.set_local_db_data({ id: opts.sel_key, value: (node||'') + '|' + (tool||'') }, 'status')
			} catch (err) {
				console.warn('[area_maintenance] could not persist map selection', err)
			}
		}

	// id → served descriptor, and the set of served ids
		const by_id = {}
		for (let i = 0; i < widgets.length; i++) {
			by_id[widgets[i].id] = widgets[i]
		}
		const strip = (html) => (html || '').replace(/<[^>]*>/g, '').trim()
		// "move_to_table" → "Move to table". Used when a widget has no dictionary
		// term: the server returns `<mark>key</mark>` for a missing label, which would
		// otherwise strip down to the raw id.
		const humanize = (id) => {
			const s = String(id || '').replace(/_/g, ' ').trim()
			return s ? (s.charAt(0).toUpperCase() + s.slice(1)) : String(id || '')
		}
		const tool_label = (id) => {
			const raw = by_id[id] ? by_id[id].label : ''
			if (!raw || raw.includes('<mark')) { return humanize(id) } // missing term
			const s = strip(raw)
			return (!s || s===id) ? humanize(id) : s
		}

	// base node readouts — real values known client-side up front (page_globals),
	// so every node carries useful info on first paint (probes below refine the
	// live-changing ones). Nothing invented: unknown fields fall back to a plain
	// descriptor, never a fake value.
		const G = (typeof page_globals!=='undefined' && page_globals) ? page_globals : {}
		const truthy	= (v) => v===true || v===1 || v==='1'
		const pg_ver	= String(G.pg_version || '').replace(/\s*\(.*\)\s*/, '').trim()
		const runtime	= String(G.php_version || '').trim()
		const user		= String(G.username || G.full_username || '').trim()
		const entity	= String(G.dedalo_entity || G.dedalo_db_name || '').trim()
		const code_ver	= String(G.dedalo_version || '').trim()
		const maint		= truthy(G.maintenance_mode)
		const recov		= truthy(G.recovery_mode)
		const MAP_BASE = {
			clients:{ status:'ok',   state:'Connected',                    sub: user ? ('@'+user) : 'sessions' },
			web:	{ status:'ok',   state: runtime || 'Web server',       sub: (typeof location!=='undefined' && location.host) || 'http' },
			core:	{ status:(maint||recov) ? 'warn' : 'ok',
					  state: maint ? 'Maintenance mode' : recov ? 'Recovery mode' : (code_ver ? ('v'+code_ver) : 'Dédalo core'),
					  sub: entity || 'engine' },
			tools:	{ status:'idle', state:'Tools',                       sub:'registry' },
			// no probe ever refines this one (see MAP_NODES), so the base line stays on
			// screen — it describes the surfaces instead of echoing the node title
			dev:	{ status:'idle', state:'Sandboxes',                    sub:'API · SQO · fixture' },
			pg:		{ status:'ok',   state:'Online',                       sub: pg_ver ? ('PostgreSQL '+pg_ver) : 'database' },
			bak:	{ status:'idle', state:'Backups',                     sub:'snapshots' },
			pub:	{ status:'idle', state:'Publication',                 sub:'diffusion engine' },
			media:	{ status:'idle', state:'Media store',                 sub:'protected assets' },
			onto:	{ status:'idle', state:'Ontology',                    sub:'definition model' }
		}

	// live status per node id: 'idle' (neutral) | 'ok' | 'warn' | 'bad'
		const status_by_id = {}
		const state_by_id = {}
		const sub_by_id = {}
		MAP_NODES.forEach(n => {
			const b = MAP_BASE[n.id] || { status:'idle', state:n.title, sub:'' }
			status_by_id[n.id]	= b.status
			state_by_id[n.id]	= b.state
			sub_by_id[n.id]		= b.sub
		})

	// ---- root ----
		const root = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'maintenance_map'
		})

	// summary + hint
		const summary = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'map_summary',
			parent			: root
		})
		ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'map_hint',
			inner_html		: (get_label.maintenance_map_hint
				|| 'Click a subsystem to see its status and the tools that act on it.')
				+ ' Tools in <span class="danger_key">red</span> are destructive or irreversible.',
			parent			: root
		})

	// stage + edges svg
		const stage_wrap = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'map_stage_wrap',
			parent			: root
		})
		const stage = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'map_stage',
			parent			: stage_wrap
		})
		const SVG_NS = 'http://www.w3.org/2000/svg'
		const edges_svg = document.createElementNS(SVG_NS, 'svg')
		edges_svg.setAttribute('class', 'map_edges')
		edges_svg.setAttribute('preserveAspectRatio', 'none')
		stage.appendChild(edges_svg)

	// context panel
		const context = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'map_context',
			parent			: root
		})

	// ---- nodes ----
		let selected = null
		const node_els = {}
		MAP_NODES.forEach(n => {
			const el = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'map_node' + (n.kind ? (' kind_' + n.kind) : ''),
				parent			: stage
			})
			el.style.left	= n.x + '%'
			el.style.top	= n.y + '%'
			// the identifying icon is CSS-owned (masked svg, one rule per node id
			// in area_maintenance.less) — the id is the only thing the JS states
			el.dataset.node	= n.id
			el.innerHTML =
				'<div class="n_top"><span class="map_dot"></span>' +
				'<span class="n_title"></span><span class="n_icon"></span></div>' +
				'<div class="n_state"></div><div class="n_sub"></div>'
			el.querySelector('.n_title').textContent = n.title
			el.addEventListener('click', () => select_node(n.id))
			node_els[n.id] = el
		})
		// paint node visuals from current status maps
		const paint_node = (id) => {
			const el	= node_els[id]
			const st	= status_by_id[id]
			if (!el) { return }
			el.classList.remove('warn', 'bad')
			if (st==='warn') { el.classList.add('warn') }
			if (st==='bad')  { el.classList.add('bad') }
			el.querySelector('.map_dot').className = 'map_dot ' + (st==='idle' ? '' : st)
			el.querySelector('.n_state').textContent	= state_by_id[id] || ''
			el.querySelector('.n_sub').textContent		= sub_by_id[id] || ''
			// warn/bad badge
			let badge = el.querySelector('.n_badge')
			if (st==='warn' || st==='bad') {
				if (!badge) {
					badge = document.createElement('span')
					badge.className = 'n_badge'
					badge.textContent = '!'
					el.appendChild(badge)
				}
			} else if (badge) {
				badge.remove()
			}
		}
		MAP_NODES.forEach(n => { paint_node(n.id) })

	// ---- summary line ----
		const paint_summary = () => {
			const warn_nodes = MAP_NODES.filter(n => status_by_id[n.id]==='warn' || status_by_id[n.id]==='bad')
			const known = MAP_NODES.filter(n => status_by_id[n.id]!=='idle')
			const healthy = known.length - warn_nodes.length
			let html = '<span class="s_seg"><span class="map_dot ok"></span><b>' + healthy + '</b>&nbsp;healthy</span>'
			if (warn_nodes.length) {
				html += '<span class="s_seg warn"><span class="map_dot warn"></span><b>' + warn_nodes.length +
					'</b>&nbsp;need attention — ' + warn_nodes.map(n => n.title).join(', ') + '</span>'
			}
			summary.innerHTML = html
			const warn_seg = summary.querySelector('.s_seg.warn')
			if (warn_seg && warn_nodes.length) {
				warn_seg.addEventListener('click', () => select_node(warn_nodes[0].id))
			}
		}
		paint_summary()

	// ---- edges ----
		const center = (id) => {
			const s = stage.getBoundingClientRect()
			const r = node_els[id].getBoundingClientRect()
			return { x: r.left + r.width/2 - s.left, y: r.top + r.height/2 - s.top }
		}
		const draw_edges = () => {
			const s = stage.getBoundingClientRect()
			if (s.width===0 || s.height===0) { return } // hidden view: no layout yet
			edges_svg.setAttribute('viewBox', '0 0 ' + s.width + ' ' + s.height)
			while (edges_svg.firstChild) { edges_svg.removeChild(edges_svg.firstChild) }
			MAP_EDGES.forEach(([a, b, mod]) => {
				const A = center(a), B = center(b)
				const mid = (A.y + B.y) / 2
				const d = 'M ' + A.x + ' ' + A.y + ' C ' + A.x + ' ' + mid + ', ' + B.x + ' ' + mid + ', ' + B.x + ' ' + B.y
				const p = document.createElementNS(SVG_NS, 'path')
				p.setAttribute('d', d)
				let cls = 'flow'
				if (mod==='dim') { cls = 'dim' }
				if (selected && (a===selected || b===selected)) {
					const warn = status_by_id[a]!=='ok' && status_by_id[a]!=='idle'
						|| status_by_id[b]!=='ok' && status_by_id[b]!=='idle'
					cls = 'act' + (warn ? ' warn' : '')
				}
				p.setAttribute('class', cls)
				edges_svg.appendChild(p)
			})
		}
	// Everything rooted OUTSIDE this map is stored, so destroy() can undo it.
	// An observer built anonymously, or a listener added to window/document, has
	// no owner: opening the maintenance area again just adds another one, each
	// retaining a whole detached diagram (draw_edges closes over stage,
	// edges_svg and status_by_id). Same shape as the 3D viewer's leak.
		let stage_resize_observer = null
		if (window.ResizeObserver) {
			stage_resize_observer = new ResizeObserver(() => draw_edges())
			stage_resize_observer.observe(stage)
		}
		window.addEventListener('resize', draw_edges)

	// apply a status update to a node (and refresh dependents)
		const set_node_status = (id, status, state, sub) => {
			if (!(id in status_by_id)) { return }
			status_by_id[id]	= status
			if (state!==undefined) { state_by_id[id] = state }
			if (sub!==undefined)   { sub_by_id[id] = sub }
			paint_node(id)
			paint_summary()
			draw_edges()
			// if this node's panel is open, keep its header in sync (a probe may
			// land after the panel was already rendered from the base value)
			if (id===selected) {
				const head = context.querySelector('.ctx_head')
				if (head) {
					const dot = head.querySelector('.map_dot')
					if (dot) { dot.className = 'map_dot ' + (status_by_id[id]==='idle' ? '' : status_by_id[id]) }
					const st = head.querySelector('.ctx_state')
					if (st) { st.textContent = state_by_id[id] || '' }
					const sb = head.querySelector('.ctx_sub')
					if (sb) { sb.textContent = sub_by_id[id] || '' }
				}
			}
		}

	// ---- context panel ----
		let mount_token = 0
		const select_node = (id, preferred_tool) => {
			selected = id
			const n = MAP_NODES.find(x => x.id===id)
			Object.keys(node_els).forEach(k => { node_els[k].classList.toggle('sel', k===id) })

			// available tools for this node (served ids only), preserving order
			const tools = n.tools.filter(tid => by_id[tid])

			context.innerHTML =
				'<div class="ctx_head">' +
					'<span class="map_dot ' + (status_by_id[id]==='idle' ? '' : status_by_id[id]) + '"></span>' +
					'<span class="ctx_title"></span>' +
					'<span class="ctx_widget_id"></span>' +
					'<span class="ctx_state"></span>' +
					'<span class="ctx_sub"></span>' +
				'</div>' +
				'<div class="ctx_tools"></div>' +
				'<div class="ctx_body"></div>'
			context.querySelector('.ctx_title').textContent = n.title
			context.querySelector('.ctx_state').textContent = state_by_id[id] || ''
			context.querySelector('.ctx_sub').textContent = sub_by_id[id] || ''

			const tools_wrap = context.querySelector('.ctx_tools')
			if (!tools.length) {
				tools_wrap.innerHTML = '<span class="map_ctx_lead">No tools served for this subsystem on this engine.</span>'
			}
			tools.forEach(tid => {
				const chip = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'tool_chip' + (MAP_DANGER_IDS.has(tid) ? ' danger' : ''),
					parent			: tools_wrap
				})
				chip.innerHTML = '<span class="tc_dot"></span>'
				chip.appendChild(document.createTextNode(tool_label(tid)))
				chip.dataset.id = tid
				if (MAP_DANGER_IDS.has(tid)) {
					chip.title = 'Destructive / irreversible operation'
				}
				chip.addEventListener('click', () => select_tool(id, tid))
			})

			draw_edges()
			if (tools.length) {
				const pick = (preferred_tool && tools.includes(preferred_tool)) ? preferred_tool : tools[0]
				select_tool(id, pick)
			} else {
				persist_sel(id, '')
			}
		}

		const select_tool = async (node_id, tid) => {
			const token = ++mount_token
			const body = context.querySelector('.ctx_body')
			if (!body) { return }
			context.querySelectorAll('.tool_chip').forEach(c => { c.classList.toggle('sel', c.dataset.id===tid) })
			persist_sel(node_id, tid)

			// widget name — the module id (e.g. 'update_ontology'), non-intrusive in
			// the header so the operator can cite the exact tool. Text only: the id
			// is served data, never an HTML sink.
			const id_el = context.querySelector('.ctx_widget_id')
			if (id_el) {
				id_el.textContent	= tid
				id_el.title			= 'Widget module: ' + tid
			}

			// (!) Destroy the outgoing tool BEFORE wiping its DOM. `innerHTML=''`
			// detaches nodes without running any teardown, so every instance
			// mounted here was orphaned — its dependencies never released, its
			// events never unbound. That has been true for every widget the map
			// view can mount, not just live ones; a widget holding an open
			// stream is simply the first case where the leak is observable.
			// destroy() carries its own double-destroy guard, so this is safe
			// even if the widget was already torn down.
			for (const widget_body of body.querySelectorAll('.widget_body')) {
				const instance = widget_body.widget_instance
				if (instance && typeof instance.destroy==='function') {
					try {
						instance.destroy(true, true, false)
					} catch (error) {
						console.error('[area_maintenance] widget destroy failed', error)
					}
				}
			}
			body.innerHTML = ''

			const descriptor = by_id[tid]
			if (!descriptor) { return }

			// lead: one-line "what this does" above the tool (the mockup's .lead)
			const tool_lead = (MAP_TOOL_DESC_LABEL[tid] && get_label[MAP_TOOL_DESC_LABEL[tid]])
				|| MAP_TOOL_DESC[tid]
			if (tool_lead) {
				ui.create_dom_element({
					element_type	: 'p',
					class_name		: 'map_ctx_lead',
					inner_html		: tool_lead,
					parent			: body
				})
			}

			// host card — same structure the List view uses, minus a duplicate DOM id.
			// The widget's own accordion label is hidden by CSS so its body renders
			// integrated directly under the panel header.
			const container = ui.create_dom_element({
				element_type	: 'div',
				dataset			: { category: descriptor.category || 'general' },
				class_name		: 'widget_container ' + (descriptor.class || ''),
				parent			: body
			})

			const fragment = await render_widget(descriptor, self)
			// a newer selection landed while awaiting — drop this one. (Do NOT gate on
			// body.isConnected: the very first selection is mounted while the whole area
			// is still detached, before the wrapper is inserted into the document.)
			if (token!==mount_token) {
				return
			}
			container.appendChild(fragment)
			container.classList.add('loaded')

			// auto-open the accordion so the tool is usable immediately
			const label = container.querySelector('.widget_label')
			requestAnimationFrame(() => {
				const wbody = container.querySelector('.widget_body')
				if (label && wbody && wbody.classList.contains('hide')) {
					label.click()
				}
			})

			// mirror the widget's own health verdict onto the node (progressive truth):
			// widgets that self-report add 'danger'/'success' to their .widget_container.
			const reflect = () => {
				if (container.classList.contains('danger')) {
					set_node_status(node_id, 'bad')
				} else if (container.classList.contains('success') && status_by_id[node_id]==='idle') {
					set_node_status(node_id, 'ok')
				}
			}
			if (window.MutationObserver) {
				const obs = new MutationObserver(reflect)
				obs.observe(container, { attributes:true, attributeFilter:['class'] })
				// stop watching after a short settle window to avoid a lingering observer
				setTimeout(() => obs.disconnect(), 20000)
			}
		}

	// ---- idle health probes ----
	// Read-only, cheap, and each defensive: any missing/oddly-shaped payload leaves
	// the node on its page_globals base — a probe never invents a value.
		const probe_value = async (id) => {
			try {
				const api_response = await data_manager.request({
					use_worker	: true,
					body		: {
						dd_api			: 'dd_area_maintenance_api',
						action			: 'get_widget_value',
						prevent_lock	: true,
						source			: { type:'widget', model:id }
					},
					retries	: 1,
					timeout	: 60 * 1000
				})
				return api_response ? response_data(api_response) : null
			} catch (err) {
				console.warn('[area_maintenance] map health probe failed:', id, err)
				return null
			}
		}
		const probe_action = async (model, action, options={}) => {
			try {
				const api_response = await data_manager.request({
					use_worker	: true,
					body		: {
						dd_api			: 'dd_area_maintenance_api',
						action			: 'widget_request',
						prevent_lock	: true,
						source			: { type:'widget', model, action },
						options
					},
					retries	: 1,
					timeout	: 60 * 1000
				})
				return api_response ? response_data(api_response) : null
			} catch (err) {
				console.warn('[area_maintenance] map action probe failed:', model, action, err)
				return null
			}
		}
		const cap = (s) => s ? (s.charAt(0).toUpperCase() + s.slice(1)) : s
		let probed = false
		const run_probes = () => {
			if (probed) { return }
			probed = true

			// PostgreSQL — read-only catalog snapshot + statistics health (WC-074).
			// The probe already returned `statistics`; before WC-074 it was fetched
			// and thrown away, so a degraded planner-statistics state was invisible
			// on the map. 'warn' not 'bad': the database is serving fine, it just
			// needs an ANALYZE.
			dd_request_idle_callback(async () => {
				if (!by_id['database_info']) { return }
				const r = await probe_value('database_info')
				if (r && Array.isArray(r.tables)) {
					const degraded	= r.statistics?.status==='degraded'
					const stale		= Number(r.statistics?.never_analyzed || 0) + Number(r.statistics?.counters_reset || 0)
					const sub		= r.tables.length + ' tables' + (degraded ? ' · statistics degraded' : '')
					set_node_status(
						'pg',
						degraded ? 'warn' : 'ok',
						degraded ? 'Statistics degraded' : 'Online',
						degraded && stale>0 ? sub + ' (' + stale + ')' : sub
					)
				}
			})

			// Publication — native diffusion engine status
			dd_request_idle_callback(async () => {
				if (!by_id['diffusion_server_control']) { return }
				const r = await probe_value('diffusion_server_control')
				if (r && r.scheduler) {
					const paused	= r.scheduler.paused===true
					const pending	= Number(r.pending || 0)
					const running	= Number(r.scheduler.running || 0)
					const queued	= Number(r.scheduler.queued || 0)
					const warn		= paused || pending>0
					const sub		= running + ' running · ' + queued + ' queued' + (pending ? ' · ' + pending + ' pending' : '')
					set_node_status('pub', warn ? 'warn' : 'ok', paused ? 'Paused' : 'Running', sub)
				}
			})

			// Media store — access-protection mode
			dd_request_idle_callback(async () => {
				if (!by_id['media_control']) { return }
				const r = await probe_value('media_control')
				if (r && ('mode' in r)) {
					const mode = r.mode===false ? 'off' : String(r.mode || '')
					if (mode) {
						set_node_status('media', 'ok',
							mode==='private' ? 'Protected' : cap(mode),
							'mode: ' + mode)
					}
				}
			})

			// Ontology — installed snapshot version
			dd_request_idle_callback(async () => {
				if (!by_id['update_ontology']) { return }
				const r = await probe_value('update_ontology')
				const ver = r && r.current_ontology ? r.current_ontology.version : null
				if (ver) {
					set_node_status('onto', 'ok', 'v' + ver, 'installed model')
				}
			})

			// Tools — registered tool packages (one read-only SELECT on matrix_tools).
			//
			// The node reports the REGISTRY STATE, not just the row count: it reads
			// `registry_state`, the verdict the widget itself computes (outdated /
			// unregistered / missing names). It is deliberately NOT re-derived from
			// the rows here — this node once counted rows only and stayed green over
			// a red panel, and a second copy of the predicates in this file would be
			// free to drift from the panel's again.
			//
			// `errors` is the widget's own pre-flight verdict (an outdated ontology
			// missing the dd1644 Developer term) and outranks the drifts: it says the
			// registry cannot be trusted at all.
			dd_request_idle_callback(async () => {
				if (!by_id['register_tools']) { return }
				const r = await probe_value('register_tools')
				if (!r || !Array.isArray(r.datalist)) { return }
				const errors	= Array.isArray(r.errors) ? r.errors.length : 0
				const n			= r.datalist.length
				const state		= n + (n===1 ? ' tool' : ' tools')

				if (errors) {
					set_node_status('tools', 'warn', state, 'registry outdated')
					return
				}

				const registry	= r.registry_state || {}
				const counts	= [
					{ n: (registry.outdated || []).length,		label: get_label.tools_outdated_count || '${count} outdated' },
					{ n: (registry.unregistered || []).length,	label: get_label.tools_not_registered_count || '${count} not registered' },
					{ n: (registry.missing || []).length,		label: get_label.tools_missing_count || '${count} missing on disk' }
				]
				const parts = counts
					.filter(item => item.n > 0)
					.map(item => format_label(item.label, {count: item.n}))

				set_node_status('tools', parts.length ? 'warn' : 'ok', state,
					parts.length ? parts.join(' · ') : 'registered')
			})

			// Backups — age of the most recent dump (warn when stale)
			dd_request_idle_callback(async () => {
				if (!by_id['make_backup']) { return }
				const r = await probe_action('make_backup', 'get_dedalo_backup_files', { max_files: 1 })
				const files = r && Array.isArray(r.psql_backup_files) ? r.psql_backup_files : null
				if (!files) { return }
				if (!files.length) {
					set_node_status('bak', 'warn', 'No backups', 'none yet')
					return
				}
				const m = String(files[0].name || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
				if (!m) {
					set_node_status('bak', 'ok', files.length + ' backups', '')
					return
				}
				const days = Math.floor((Date.now() - new Date(+m[1], +m[2]-1, +m[3]).getTime()) / 86400000)
				const label = days<=0 ? 'Today' : days===1 ? '1 day old' : days + ' days old'
				set_node_status('bak', days>14 ? 'warn' : 'ok', label, m[0])
			})
		}

	// ---- command palette (⌘K) ----
		const palette_backdrop = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'map_palette_backdrop',
			parent			: root
		})
		palette_backdrop.innerHTML =
			'<div class="map_palette">' +
				'<div class="map_palette_in"><input type="text" autocomplete="off" placeholder="Type a tool name…"></div>' +
				'<div class="map_palette_list"></div>' +
			'</div>'
		const palette_input = palette_backdrop.querySelector('input')
		const palette_list = palette_backdrop.querySelector('.map_palette_list')
		// node title for each served id (first node that lists it), for the palette hint column
		const node_of = (id) => {
			const n = MAP_NODES.find(x => x.tools.includes(id))
			return n ? n.title : '—'
		}
		widgets.forEach(w => {
			const item = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'p_item',
				parent			: palette_list
			})
			item.dataset.id		= w.id
			item.dataset.search	= strip(w.label).toLowerCase() + ' ' + w.id
			item.innerHTML =
				'<span class="map_dot ' + (MAP_DANGER_IDS.has(w.id) ? 'bad' : '') + '"></span>' +
				'<span class="p_name"></span><span class="p_zone"></span>'
			item.querySelector('.p_name').textContent = tool_label(w.id)
			item.querySelector('.p_zone').textContent = node_of(w.id)
			item.addEventListener('click', () => open_tool(w.id))
		})
		const filter_palette = () => {
			const q = palette_input.value.trim().toLowerCase()
			let first = null
			palette_list.querySelectorAll('.p_item').forEach(it => {
				const show = !q || it.dataset.search.includes(q)
				it.classList.toggle('hide', !show)
				it.classList.remove('sel')
				if (show && !first) { first = it }
			})
			if (first) { first.classList.add('sel') }
		}
		const open_palette = () => {
			palette_backdrop.classList.add('open')
			palette_input.value = ''
			filter_palette()
			palette_input.focus()
		}
		const close_palette = () => palette_backdrop.classList.remove('open')
		const open_tool = (id) => {
			const n = MAP_NODES.find(x => x.tools.includes(id))
			if (n) {
				select_node(n.id)
				select_tool(n.id, id)
				context.scrollIntoView({ behavior:'smooth', block:'center' })
			}
			close_palette()
		}
		palette_input.addEventListener('input', filter_palette)
		palette_backdrop.addEventListener('click', (e) => { if (e.target===palette_backdrop) { close_palette() } })
		// global ⌘K / Esc — guarded so it only acts while this map is in the live DOM
		const on_keydown = (e) => {
			if (!document.body.contains(root)) { return }
			if ((e.metaKey || e.ctrlKey) && (e.key==='k' || e.key==='K')) {
				e.preventDefault()
				palette_backdrop.classList.contains('open') ? close_palette() : open_palette()
			} else if (e.key==='Escape' && palette_backdrop.classList.contains('open')) {
				close_palette()
			} else if (palette_backdrop.classList.contains('open') && e.key==='Enter') {
				const sel = palette_list.querySelector('.p_item.sel:not(.hide)')
				if (sel) { open_tool(sel.dataset.id) }
			}
		}
		// The `contains(root)` guard above stops a STALE map from acting, but a
		// guarded listener is still a listener: document keeps it, and it keeps
		// the map. Guarding is not removing.
		document.addEventListener('keydown', on_keydown)

	// OPEN_WIDGET_EVENT (maintenance_events.js): another widget asks to show this
	// one (media_control's publication-hosts line). Guarded like on_keydown, so a
	// stale map never acts; removed in destroy().
		const on_open_widget = (e) => {
			if (!document.body.contains(root)) { return }
			const id = e.detail && e.detail.id
			if (!id || !by_id[id]) { return }
			if (opts && typeof opts.show_map==='function') { opts.show_map() }
			open_tool(id)
		}
		document.addEventListener(OPEN_WIDGET_EVENT, on_open_widget)

	// on_show — called when the map view becomes visible; draw edges (which need
	// layout) and kick off the idle health probes the first time.
		const on_show = () => {
			requestAnimationFrame(() => {
				draw_edges()
				run_probes()
			})
		}

	// initial selection: the persisted node+tool if still valid, else PostgreSQL
		const saved = opts && opts.saved_sel
		const init_node = (saved && MAP_NODES.some(n => n.id===saved.node)) ? saved.node : 'pg'
		const init_tool = (saved && saved.tool && by_id[saved.tool]) ? saved.tool : null
		select_node(init_node, init_tool)


	// destroy — release everything anchored outside `root`. Idempotent: the area
	// may be torn down more than once, and a second call must not throw.
		const destroy = () => {
			if (stage_resize_observer) {
				stage_resize_observer.disconnect()
				stage_resize_observer = null
			}
			window.removeEventListener('resize', draw_edges)
			document.removeEventListener('keydown', on_keydown)
			document.removeEventListener(OPEN_WIDGET_EVENT, on_open_widget)
		}

	return { node: root, on_show, open_palette, open_tool, destroy }
}//end build_map_view



/**
* RENDER_WIDGET
* Builds the accordion-style DOM fragment for a single maintenance widget card
* and runs the full widget lifecycle (init → build → render → deferred load).
*
* Structure of the returned fragment
* ------------------------------------
*   <DocumentFragment>
*     <div class="widget_label icon_arrow">…label HTML…</div>   ← accordion toggler
*     <div class="widget_body hide">                             ← accordion body (initially closed)
*       <div class="body_info">…widget.render() output…</div>
*     </div>
*   </DocumentFragment>
*
* The fragment is inserted directly into the `.widget_container` card by
* `ui.load_item_with_spinner` in `get_content_data()`.
*
* Widget module resolution
* ------------------------
* The widget ES module is located at `../widgets/<item.id>/js/<item.id>.js` relative
* to this file. The module **must** export a constructor whose name exactly matches
* `item.id` (e.g. `export const make_backup = function() {…}`). If the export does
* not exist, or if the import fails (404, network error), an error is logged and an
* empty fragment is returned — the card accordion shell is still rendered so the
* user sees the label but no body content.
*
* Lazy-load strategy
* ------------------
* `widget.build()` runs the shell construction without fetching data from the server.
* Data is fetched only when the accordion opens, via `trigger_load()` → `widget.load()`.
* Two exceptions:
*   - "Background" widgets (those in `background_widget_ids` OR with `item.background===true`)
*     call `trigger_load()` at idle priority via `dd_request_idle_callback` even while
*     closed, so that status information is visible as soon as the admin opens the area.
*   - Widgets whose accordion was left open in a previous session (open state persisted
*     by `ui.collapse_toggle_track`) have their body visible immediately; in this case
*     `expose_callback` fires before `widget_instance` is assigned, so an explicit
*     `trigger_load()` call after `widget_instance = widget` fills the gap.
*
* Alt-click shortcut
* ------------------
* Clicking the widget body while holding Alt triggers `widget_instance.refresh()`,
* which re-runs the full build → render → load cycle. This is a developer affordance
* and is not surfaced in the UI.
*
* Collapse persistence
* --------------------
* `ui.collapse_toggle_track` persists the open/closed state under the key
* `'collapsed_' + item.id` in the local IndexedDB store so the state survives page
* refreshes.
*
* @param {Object} item - Widget descriptor from the server datalist
* @param {string} item.id       - Widget identifier; used as module name and key
* @param {string} [item.label]  - Display label (may contain HTML)
* @param {string} [item.category] - Category bucket key
* @param {boolean} [item.background] - When true, load at idle priority before open
* @param {*} [item.value]       - Optional widget-specific payload forwarded to `widget.init()`
* @param {Object} self - The `area_maintenance` instance (provides section_tipo, lang, mode, etc.)
* @returns {Promise<DocumentFragment>} Fragment containing the accordion label + body;
*   body content is empty when the widget module fails to load
*/
const render_widget = async (item, self) => {

	const fragment = new DocumentFragment()

	// Validate item.id early to prevent issues with path construction and module loading.
	if (!item || !item.id) {
		console.error('RENDER_WIDGET Error: Widget item or item.id is missing.', item);
		return fragment; // Return an empty fragment or handle as appropriate
	}

	let widget_instance = null

	// background-status widgets load at idle priority even while collapsed,
	// so admins see status without opening them. Server may also flag via item.background.
	const background_widget_ids = ['system_info', 'update_data_version']
	const is_background = item.background===true || background_widget_ids.includes(item.id)

	// unified load trigger (uses the widget's own load() override if present,
	// else the shared widget_common default).
	// (!) RETURNS the loader promise. A widget that starts a live feed on open
	// must not begin before its value exists, or its first frame lands against
	// the spinner DOM instead of a rendered widget; trigger_open below chains
	// on this. Discarding the promise here made that ordering unobservable.
	const trigger_load = () => {
		if (!widget_instance) {
			return Promise.resolve()
		}
		const loader = (typeof widget_instance.load==='function')
			? widget_instance.load.bind(widget_instance)
			: widget_common.prototype.load.bind(widget_instance)
		return Promise.resolve(loader())
	}

	// open = load, THEN tell the widget it is visible.
	// load() is one-shot guarded (widget_common), so a re-expose never re-enters
	// it — which is exactly why a widget cannot use load() as its "I am visible
	// now" signal and needs on_expose.
	const trigger_open = () => trigger_load().then(() => {
		if (widget_instance && typeof widget_instance.on_expose==='function') {
			widget_instance.on_expose()
		}
	}).catch((error) => console.error('[area_maintenance] widget open failed', error))

	// label
		const label = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'widget_label icon_arrow',
			inner_html		: item.label || '',
			parent			: fragment,
		})

	// body
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'widget_body hide',
			parent			: fragment
		})
		const click_handler = (e) => {
			e.stopPropagation()
			if(e.altKey) {
				widget_instance.refresh()
			}
		}
		body.addEventListener('click', click_handler)

	// collapse_toggle_track
		const collapse = () => {
			label.classList.remove('up')
			// (!) Forward the collapse to the widget. Until this line, collapsing
			// an accordion did NOTHING but flip a class — no destroy(), no
			// notification of any kind — so a widget holding a live resource (an
			// SSE reader, a timer) had no way to learn it was no longer visible
			// and would keep it open behind a display:none panel.
			if (widget_instance && typeof widget_instance.on_collapse==='function') {
				widget_instance.on_collapse()
			}
		}
		const expose = () => {
			label.classList.add('up')
			// unified lazy load: fetch widget data only when opened, then signal
			// visibility once the value is actually there
			trigger_open()
		}
		ui.collapse_toggle_track({
			toggler				: label,
			container			: body,
			collapsed_id		: 'collapsed_' + item.id,
			collapse_callback	: collapse,
			expose_callback		: expose,
			default_state		: 'closed'
		})

	// widget module check. Use if exists
		try {

			const path = `../widgets/${item.id}/js/${item.id}.js`

			const module = await import(path)

			// Ensure the module exports a constructor with the item.id name
			if (typeof module[item.id] !== 'function') {
				throw new Error(`Widget module for ID '${item.id}' found, but does not export a constructor named '${item.id}'.`);
			}

			// instance widget
			const widget = new module[item.id]()

			// init widget
			await widget.init({
				id				: item.id,
				section_tipo	: self.section_tipo,
				section_id		: self.section_id,
				lang			: self.lang,
				mode			: self.mode, // list
				model			: 'widget',
				name			: item.label,
				value			: item.value,
				caller			: self
			})

			// build shell only — no eager data fetch.
			// Data loads on open via trigger_load() (see expose / background below).
			await widget.build()

			// render
			const node = await widget.render()

			 // Ensure the rendered node is an element before adding class
			if (node instanceof Element) {
				// add CSS class for selection
				node.classList.add('body_info');

				body.appendChild(node)
			} else {
				console.warn(`Widget '${item.id}' render() did not return an HTML element. Cannot add 'body_info' class.`);
			}

			widget_instance = widget
			// Reachable handle for hosts that tear this DOM down directly (the
			// map view's select_tool). The closure above is not reachable from
			// the node, so without this there is no way to destroy the instance
			// before its nodes are discarded.
			body.widget_instance = widget

			// background widgets: low-priority load while still collapsed.
			// (!) trigger_LOAD, never trigger_open — a background widget fetches
			// its value while shut, and must not be told it is exposed. Collapsed
			// means no live feed, always.
			if (is_background) {
				dd_request_idle_callback(() => {
					trigger_load()
				})
			} else if (!body.classList.contains('hide')) {
				// restored-open state: expose_callback may have fired before the
				// instance was ready, so ensure the load runs now. This widget IS
				// visible, so it gets the full open (load + on_expose).
				trigger_open()
			}

		} catch (error) {
			if (error.message.includes('Failed to fetch dynamically imported module') || error.message.includes('Cannot find module')) {
				console.error(`RENDER_WIDGET Error: Widget module for '${item.id}' could not be loaded or found. Path: ../widgets/${item.id}/js/${item.id}.js`, error);
			} else {
				console.error(`RENDER_WIDGET Error during widget '${item.id}' processing:`, error);
			}
		}


	return fragment
}//end render_widget



/**
* PRINT_RESPONSE
* Clears a result container and injects a formatted view of an API response.
*
* Called after any maintenance widget action completes (form submit, background worker
* finish, etc.) to display the outcome to the administrator.
*
* The container is first emptied; then three optional sections are inserted in order:
*   1. An "eraser" button (class `button reset eraser`) that clears the container again
*      on mouseup, allowing the admin to dismiss the result without re-running the action.
*   2. FAILURE block — on `ok:false` the coded `error` is resolved by the ONE
*      text resolver (`error_text`: label in the admin's language → the
*      registry's English message → the code) and nothing else is printed.
*   3. Error block (SUCCESS only) — rendered when the widget's `errors`
*      EXTENSION KEY (read through response_extension) is a non-empty array: a
*      PARTIAL refusal the action reports beside its result (skipped rows,
*      per-item failures). Each entry is a TEXT node.
*   4. Message block — the widget's `msg` extension key (response_extension,
*      success only), then the payload's `data.summary`, then a plain "OK".
*      Envelope v2 has no prose channel on a FAILURE, and the old
*      `'Unknown API response error'` fallback made every swept handler's
*      success read as a failure.
*   5. Tree view — the full `api_response` object rendered by `render_tree_data` into
*      a `<div class="pre">` for structured inspection.
*
* (!) `api_response` is a data_manager envelope: `{ok, request_id, data,
*   notices?, …extension keys}` on a success, `{ok:false, error}` (with `error`
*   an ApiError) on a failure. The function does not guard against a null
*   `api_response`; callers must ensure the argument is a valid object.
*
* @param {HTMLElement} container - The DOM node to populate; its existing children
*   are removed before rendering
* @param {Object} api_response - The API response object from `data_manager.request()`
* @param {string|string[]} [api_response.msg] - the widget's own operator sentence (extension key)
* @param {string[]} [api_response.errors]     - the widget's per-item findings (extension key)
* @returns {HTMLElement} The same `container` element, now populated
*/
export const print_response = (container, api_response) => {

	// clean container
		while (container.firstChild) {
			container.removeChild(container.firstChild);
		}

	// button_eraser
		const button_eraser = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'button reset eraser',
			parent			: container
		})
		button_eraser.addEventListener('mouseup', function(e){
			e.stopPropagation();

			while (container.firstChild) {
				container.removeChild(container.firstChild);
			}
		})

	// FAILURE. Envelope v2 says so with `ok:false` + a coded `error`; the ONE
	// text resolver turns it into the admin's language. Nothing else is printed
	// for a failure: the compat `errors:[code]` would only repeat the code and
	// `msg` only repeats the message.
		if (request_failed(api_response)===true) {

			const error_node = ui.create_dom_element({
				element_type	: 'div',
				class_name		: 'api_response error',
				parent			: container
			})
			append_text_lines(error_node, String(error_text(api_response.error)).split(/\\n|\n/))

		}else{

			// errors (SUCCESS only) — a partial refusal the action reports BESIDE
			// its result (skipped rows, per-item failures), never the whole outcome.
			// Server text NEVER reaches an HTML sink: one text node per line.
				const action_errors = response_extension(api_response, 'errors')
				if (action_errors && action_errors.length) {
					const errors_node = ui.create_dom_element({
						element_type	: 'div',
						class_name		: 'api_response error',
						parent			: container
					})
					append_text_lines(
						errors_node,
						action_errors.map((item) => typeof item==='string' ? item : error_text(item))
					)
				}

			// msg / summary. Envelope v2 has NO prose channel on a FAILURE — that is
			// `error` — but a maintenance widget OWNS a top-level `msg` extension key
			// on its success bodies (ERRORS_SPEC §3.0; src/core/api/handlers/
			// dd_area_maintenance_api.ts lifts WidgetResponse.msg into `extend`), so
			// it is read through response_extension() — success only, never the
			// compat mirror — and `data.summary` is its successor where a handler
			// composes one. When neither exists the action simply worked — say so,
			// never 'Unknown API response error', which told an administrator that a
			// successful action had failed.
				const api_data		= response_data(api_response)
				const summary		= (api_data && typeof api_data==='object' && typeof api_data.summary==='string' && api_data.summary.length)
					? api_data.summary
					: null
				const api_msg_source	= response_extension(api_response, 'msg') || summary
				const api_msg_lines		= api_msg_source
					? (Array.isArray(api_msg_source)
						? api_msg_source
						: String(api_msg_source).split(/\\n|\n/))
					: [(typeof get_label!=='undefined' && get_label && get_label.ok) || 'OK']
				const msg_node = ui.create_dom_element({
					element_type	: 'div',
					class_name		: 'api_response',
					parent			: container
				})
				append_text_lines(msg_node, api_msg_lines)
		}

	// JSON response result
		const result = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'pre',
			parent			: container
		})
		render_tree_data(api_response, result)


	return container
}//end print_response



/**
* BUILD_FORM
* Builds a generic submission form for a maintenance widget and appends it to
* `widget_object.body_info`.
*
* This is the standard way for maintenance widgets to create a parameterised
* admin action form. The form is also accessible as `area_maintenance.prototype.init_form`
* (an alias wired in `area_maintenance.js`).
*
* `widget_object` shape
* ----------------------
*   body_info    {HTMLElement}  — Container where the form element is appended.
*   body_response {HTMLElement} — Container where `print_response()` renders results.
*   confirm_text  {string}      — Confirmation dialog message. Defaults to
*                                 `get_label.sure || 'Sure?'`.
*   inputs        {Array}       — Array of input descriptor objects (see below).
*   submit_label  {string}      — Button label. Defaults to `'OK'`.
*   trigger       {Object}      — API dispatch descriptor:
*     dd_api   {string}  — API endpoint name (e.g. `'dd_area_maintenance_api'`).
*     action   {string}  — Action name dispatched to the endpoint.
*     source   {Object}  — Optional source locator forwarded to the API.
*     options  {Object}  — Optional extra options merged with the collected input values.
*   on_submit     {Function}    — Optional: replaces the default API dispatch. Receives
*                                 `(event, values)` where `values` is an array of
*                                 `{ name, value }` objects from the input fields.
*                                 If provided, `trigger` is ignored entirely.
*   on_done       {Function}    — Optional: called with `(api_response)` after the
*                                 default API dispatch completes (not called when
*                                 `on_submit` overrides the dispatch).
*   render_response {Function}  — Optional: called with `(body_response, api_response)`
*                                 INSTEAD of the default `print_response`, for actions
*                                 whose raw JSON is too large to read (e.g. a per-tool
*                                 import report). It owns the container completely —
*                                 clearing it and providing its own dismiss affordance.
*   on_render     {Function}    — Optional: called with `({ form_container, input_nodes })`
*                                 immediately after the form is fully constructed,
*                                 allowing callers to inject extra nodes or wire events.
*
* Input descriptor shape
* ----------------------
*   type      {string}   — HTML input type (`'text'`, `'number'`, `'select'`, …).
*   name      {string}   — Field name; also used as the `{ name, value }` key in `values`.
*   label     {string}   — Placeholder text and title tooltip. For `select`, used as
*                          the disabled placeholder `<option>`.
*   mandatory {boolean}  — When true, the field must be non-empty before submit;
*                          empty mandatory fields receive the `'empty'` class and
*                          grab focus, preventing the API call.
*   value     {string}   — Pre-filled value. For `select`, marks the matching option
*                          as `selected`.
*   options   {Array<string>} — (select only) Values to render as `<option>` elements.
*
* Submit lifecycle
* ----------------
*   1. `form_container` gets class `lock` (prevents double-submit).
*   2. A spinner is prepended to `body_response`.
*   3. `data_manager.request()` is awaited with a 1-hour timeout (long-running
*      maintenance tasks may take many minutes).
*   4. `print_response()` replaces the spinner content with the formatted result.
*   5. `lock` class is removed; spinner is removed.
*   6. `on_done(api_response)` is called if provided.
*
* (!) The form uses `window.confirm()` as a confirmation gate. In some browser
* environments (iframes, certain CSPs) `confirm()` may return `true` without
* user interaction or be silently blocked. This is pre-existing behaviour.
*
* (!) `Object.assign(trigger.options, values)` mutates the original `trigger.options`
* object if it is a reference type. Callers should not rely on `trigger.options`
* being unchanged after the first submit.
*
* @param {Object} widget_object - Form configuration object (see shape above)
* @returns {HTMLElement} The constructed `<form class="form_container">` element,
*   already appended to `widget_object.body_info`. The element also exposes a
*   `form_container.button_submit` reference to the submit button node.
*/
export const build_form = function(widget_object) {

	// widget_object
		const body_info		= widget_object.body_info
		const body_response	= widget_object.body_response
		const confirm_text	= widget_object.confirm_text || get_label.sure || 'Sure?'
		const inputs		= widget_object.inputs || []
		const submit_label	= widget_object.submit_label || 'OK'
		const trigger		= widget_object.trigger || {}
		const on_submit		= widget_object.on_submit // optional replacement function to exec on submit
		const on_done		= widget_object.on_done // optional function to exec on API response
		const on_render		= widget_object.on_render // optional function to exec on render is complete
		const render_response = widget_object.render_response // optional replacement for print_response

	// create the form
		const form_container = ui.create_dom_element({
			element_type	: 'form',
			class_name		: 'form_container',
			parent			: body_info
		})
		form_container.addEventListener('submit', async function(e){
			e.preventDefault()

			// blur button
				document.activeElement.blur()

			// collect values from inputs
				const values = input_nodes.map((el)=>{
					return {
						name	: el.name,
						value	: el.value
					}
				})

			if ( confirm(confirm_text) ) {

				// check mandatory values
					for (let i = 0; i < input_nodes.length; i++) {
						if(input_nodes[i].classList.contains('mandatory') && input_nodes[i].value.length<1) {
							input_nodes[i].focus()
							input_nodes[i].classList.add('empty')
							return
						}
					}

				// button_spinner: self-contained ring spinner ON the submit button for
				// the whole request lifecycle. Unlike an absolutely-positioned overlay
				// spinner it can never escape the widget card. The finally clause guarantees
				// it is cleared on every exit path (success, error, or custom on_submit).
					button_submit.classList.add('button_spinner')

				try {
					// on_submit. Overwrites default submit action
						if (on_submit) {
							return await on_submit(e, values)
						}

					// submit data
						// NOTE: no form `lock` and no body_response spinner here — the
						// button_spinner above is the single loading indicator now (both
						// were redundant once the button shows its own spinner).
						const options = (trigger.options)
							? Object.assign(trigger.options, values)
							: values

						// data_manager
							const api_response = await data_manager.request({
								use_worker	: true,
								body		: {
									dd_api			: trigger.dd_api,
									action			: trigger.action,
									prevent_lock	: true,
									source			: trigger.source || null,
									options			: options
								},
								retries : 1, // one try only
								timeout : 3600 * 1000 // 1 hour waiting response
							})
							// A widget with a purpose-built summary owns the container;
						// everything else gets the generic message + JSON tree.
						if (render_response) {
							render_response(body_response, api_response)
						}else{
							print_response(body_response, api_response)
						}

						// on_done. Execute function after request
							if (on_done) {
								return on_done(api_response)
							}
				} finally {
					button_submit.classList.remove('button_spinner')
				}
			}
		})

	// form inputs
		const input_nodes = []
		for (let i = 0; i < inputs.length; i++) {

			const input = inputs[i]

			const class_name = input.mandatory
				? 'mandatory'
				: ''

			let input_node

			// select type
			if (input.type === 'select') {
				input_node = ui.create_dom_element({
					element_type	: 'select',
					name			: input.name,
					title			: input.label,
					class_name		: class_name,
					parent			: form_container
				})
				// add placeholder option
				ui.create_dom_element({
					element_type	: 'option',
					value			: '',
					text_content	: input.label || 'Select...',
					disabled		: true,
					selected		: !input.value,
					parent			: input_node
				})
				// add options
				if (input.options && Array.isArray(input.options)) {
					for (const option_value of input.options) {
						ui.create_dom_element({
							element_type	: 'option',
							value			: option_value,
							text_content	: option_value,
							selected		: input.value === option_value,
							parent			: input_node
						})
					}
				}
			}else{
				// default input type
				input_node = ui.create_dom_element({
					element_type	: 'input',
					type			: input.type,
					name			: input.name,
					placeholder		: input.label,
					title			: input.label,
					class_name		: class_name,
					parent			: form_container
				})
				if (input.value) {
					input_node.value = input.value
				}
			}

			input_node.addEventListener('change', function(){
				if (this.value.length>0) {
					this.classList.remove('empty')
				}
			})

			input_nodes.push(input_node)
		}

	// button submit
		const button_submit = ui.create_dom_element({
			element_type	: 'button',
			class_name		: 'light button_submit',
			inner_html		: submit_label,
			parent			: form_container
		})
		form_container.button_submit = button_submit
		button_submit.addEventListener('click', function(e){
			e.stopPropagation()
		})

	// on_render
		if (on_render) {
			on_render({form_container, input_nodes})
		}


	return form_container
}//end build_form



/**
* SET_WIDGET_LABEL_STYLE
* Adds or removes a CSS class on the outer `.widget_container` card element that
* wraps the current widget instance.
*
* Widgets call this to signal their overall health status from inside the accordion
* body, for example adding `'danger'` when a check fails or `'success'` when all
* checks pass. The class lands on the `.widget_container` (the card), not on the
* widget body node, so the label row changes colour even while the accordion is
* collapsed.
*
* DOM traversal
* -------------
* The widget's rendered node (`self.node`) sits inside:
*   .widget_container        ← target (parentNode.parentNode of self.node)
*     .widget_body
*       .body_info
*         self.node          ← widget render root
*
* Deferred execution
* ------------------
* When `self.node` is not yet mounted (e.g. called during early `build()` before
* `render()` has attached the node), the function defers via `when_in_dom(ref_node, …)`
* and retries once the reference node is inserted into the live document.
* `ref_node` should be a node that will definitely be in the DOM by the time the
* widget is visible (e.g. the widget body container).
*
* The actual class mutation is wrapped in `requestAnimationFrame` to ensure it
* happens after the current layout pass and does not cause a forced reflow.
*
* (!) If `self.node` is null and `ref_node` is also not provided (or never enters the
* DOM), this function will never execute the class mutation. Ensure `ref_node` is a
* node that the browser will eventually insert.
*
* @param {Object} self       - Widget instance; must expose `self.node` (HTMLElement|null)
* @param {string} style      - CSS class name to add or remove (e.g. `'danger'`, `'success'`)
* @param {string} mode       - `'add'` to add the class; any other value removes it
* @param {HTMLElement} ref_node - Reference node passed to `when_in_dom` when `self.node`
*   is not yet available; typically the widget's outer container
* @returns {void}
*/
export const set_widget_label_style = function (self, style, mode, ref_node) {

	if (!self.node) {
		const when_in_dom_handler = () => {
			set_widget_label_style(self, style, mode, ref_node)
		}
		when_in_dom(ref_node, when_in_dom_handler)
		return
	}

	const wrapper = self.node
	const widget_container = wrapper.parentNode?.parentNode
	if (widget_container) {
		requestAnimationFrame(()=>{
			if (mode==='remove') {
				widget_container.classList.remove(style)
			}else{
				widget_container.classList.add(style)
			}
		})
	}
}//end set_widget_label_style



// @license-end
