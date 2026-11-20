// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, get_label */
/*eslint no-undef: "error"*/
'use strict';



/**
* TEST_THESAURUS_PANE
* The gate for THE picker SURFACE: the thesaurus mounted INLINE inside the caller
* component's own wrapper (`component_portal.toggle_thesaurus_pane` +
* `build_thesaurus_pane`).
*
* WHY A SEPARATE FILE. `test_thesaurus_picker.js` deliberately imports no
* component_portal — that isolation is one of its assertions, and it is what lets a
* second host (edit-in-list) reuse the picker. This file is the opposite side: it
* imports the portal precisely to exercise the surface, so the two never blur.
*
* WHAT IT PINS, and each is a defect that actually shipped:
*
*  - THE AREA OUTLIVES A PICK. Every successful pick runs the component's own
*    `refresh()`, and refresh destroys `ar_instances`. Registering the pane's area
*    there therefore killed the tree on the very click that linked a term — the
*    panel went dark after ONE pick and had to be reopened for the next. The area
*    is owned by the pane (destroyed with it, and with the component), never by the
*    refresh cycle; and reuse is decided by asking the INSTANCE whether it is
*    alive, never by a flag.
*  - THE FAILED BUILD STAYS VISIBLE. The server distinguishes "not authorized"
*    (403, generic by design) from "no active hierarchy is configured for this
*    target" (409, named). Hiding the pane when the build fails throws that reason
*    away and leaves the button looking inert.
*  - THE NAMED REFUSAL for a component that has no pane at all: only the tree view
*    builds one, and six shipped nodes declare `button_tree` without it.
*
* THERE IS A BACKEND. The client runner logs in, so `build_thesaurus_pane` really
* instantiates an area against the server. That is what makes the liveness rule
* testable for real: a rebuild is observed as a NEW instance appearing, not as an
* error path. The failure branch is exercised separately, with a caller address the
* server cannot resolve.
*/

// imports
	import {component_portal} from '../../../core/component_portal/js/component_portal.js'
	import {buttons} from '../../../core/component_portal/js/buttons.js'
	import {event_manager} from '../../../core/common/js/event_manager.js'



// ─────────────────────────────────────────────────────────────────────────────
// fixtures
// ─────────────────────────────────────────────────────────────────────────────

// make_portal — a portal instance reduced to what the pane surface reads. Built on
// the REAL prototype (never a hand-written stand-in) so gutting either method fails
// this file instead of a mock agreeing with itself.
	const make_portal = (options={}) => {

		const self = Object.create(component_portal.prototype)

		self.id				= options.id || 'test_pane_portal'
		self.tipo			= 'test111'
		self.section_tipo	= 'test3'
		self.section_id		= options.section_id===undefined ? 1 : options.section_id
		self.lang			= 'lg-spa'
		self.ar_instances	= []
		self.data			= { entries: [] }
		self.context		= { properties: {} }
		self.picker			= null
		self.thesaurus_area	= options.thesaurus_area ?? null

		// the component wrapper. The pane is NEVER inside it: toggle_thesaurus_pane
		// creates it on document.body and positions it by measuring this node.
		self.node = document.createElement('div')
		document.body.appendChild(self.node)

		self.thesaurus_pane = null
		if (options.with_pane===true) {
			const pane = document.createElement('div')
			pane.classList.add('thesaurus_pane','hide')
			if (options.pane_child===true) {
				pane.appendChild(document.createElement('span'))
			}
			document.body.appendChild(pane)
			self.thesaurus_pane = pane
		}

		return self
	}

	const pane_of = (portal) => portal.thesaurus_pane

// visual_edge — where the pane's sides must land for a component: its box, widened
// on both sides by the --pane_edge_outset its active style declares (0 when none).
	const visual_edge = (node, outset) => {
		const rect = node.getBoundingClientRect()
		return {
			left	: `${rect.left - outset}px`,
			width	: `${rect.width + 2 * outset}px`
		}
	}



describe('THESAURUS PANE (the inline picker surface)', function() {

	// ─────────────────────────────────────────────────────────────────────────
	describe('the pane is NEVER inside the component node', function() {

		it('the pane is a body child, positioned by measuring the component', async function() {
			// THE load-bearing rule of this surface, and the one that was broken three
			// times: inside self.node the area's own drags and clicks bubble into the
			// portal's handlers (the filter's field drags reached the portal's dragover
			// and died on a `tmp.data` only the portal's dragstart writes). No guard at
			// the boundary is a substitute for not being a descendant. The pane lives
			// on document.body and gets its place from the component's bounding rect.
			const portal = make_portal({ id:'pane_outside_node' })

			await portal.toggle_thesaurus_pane()

			const pane = portal.thesaurus_pane
			assert.notEqual(pane, null, 'a pane was created')
			assert.equal(pane.parentNode, document.body, 'it hangs off body')
			assert.equal(portal.node.contains(pane), false,
				'it must NEVER be inside the component node')
			assert.notEqual(pane.style.top, '', 'positioned by measurement, not by CSS containment')
			assert.notEqual(pane.style.left, '')
			assert.notEqual(pane.style.width, '')
		})

		it('the pane tracks the component: it is re-measured on scroll', async function() {
			const portal = make_portal({ id:'pane_tracks_scroll' })
			portal.node.style.cssText = 'position:absolute; top:100px; left:40px; width:300px; height:50px;'

			await portal.toggle_thesaurus_pane()
			const pane = portal.thesaurus_pane
			const first_top = pane.style.top

			// move the component and let the scroll listener re-measure
			portal.node.style.top = '260px'
			window.dispatchEvent(new Event('scroll'))

			assert.notEqual(pane.style.top, first_top, 'the pane followed the component')
			// flush with the component's box: this node declares no --pane_edge_outset
			assert.equal(pane.style.left, visual_edge(portal.node, 0).left)
			assert.equal(pane.style.left, '40px')
			assert.equal(pane.style.width, '300px')
		})

		it('the SIZE the operator drags to survives a scroll (position tracks, size is theirs)', async function() {
			// The scroll reposition used to rewrite width/height on every event, so
			// the pane snapped back to its default on the first scroll after the
			// operator resized it. Position must follow the component; size must not
			// be touched again after open.
			const portal = make_portal({ id:'pane_size_persists' })
			portal.node.style.cssText = 'position:absolute; top:100px; left:40px; width:300px; height:50px;'
			await portal.toggle_thesaurus_pane()
			const pane = portal.thesaurus_pane

			// the operator drags it
			pane.style.width	= '640px'
			pane.style.height	= '420px'

			// the page scrolls under it
			portal.node.style.top = '260px'
			window.dispatchEvent(new Event('scroll'))

			assert.equal(pane.style.width,  '640px', 'width must not be reset by a scroll')
			assert.equal(pane.style.height, '420px', 'height must not be reset by a scroll')
			assert.equal(pane.style.left, visual_edge(portal.node, 0).left, 'position still tracks the component')
		})

		it('the remembered size is applied again on the NEXT open', async function() {
			const portal = make_portal({ id:'pane_size_reopen' })
			await portal.toggle_thesaurus_pane()
			// simulate the ResizeObserver having recorded a drag
			portal.thesaurus_pane_size = { width:'700px', height:'380px' }
			await portal.toggle_thesaurus_pane() // close
			await portal.toggle_thesaurus_pane() // reopen

			const pane = portal.thesaurus_pane
			assert.equal(pane.style.width,  '700px')
			assert.equal(pane.style.height, '380px')
		})

		it('a component on the RIGHT of the window anchors the pane to its right edge', async function() {
			// Pinned to the component's LEFT edge, a pane wider than the component
			// runs off the viewport when the component sits on the right of the form.
			// It must anchor to whichever edge keeps it on screen.
			const portal = make_portal({ id:'pane_right_side' })
			const width = 300
			const left  = window.innerWidth - width - 20 // hard against the right edge
			portal.node.style.cssText = `position:absolute; top:100px; left:${left}px; width:${width}px; height:50px;`

			await portal.toggle_thesaurus_pane()
			const pane = portal.thesaurus_pane
			// the pane is wider than the component (min-width), so left-anchoring
			// would overflow: it must have flipped
			assert.equal(pane.style.left, 'auto', 'not anchored to the left edge')
			assert.notEqual(pane.style.right, 'auto')
			assert.notEqual(pane.style.right, '')
			// and it stays on screen
			const rect = pane.getBoundingClientRect()
			assert.equal(rect.right <= window.innerWidth, true, 'the pane must not run off the right')
		})

		it('a component on the LEFT keeps the left anchor', async function() {
			const portal = make_portal({ id:'pane_left_side' })
			portal.node.style.cssText = 'position:absolute; top:100px; left:20px; width:300px; height:50px;'

			await portal.toggle_thesaurus_pane()
			const pane = portal.thesaurus_pane
			assert.equal(pane.style.left, visual_edge(portal.node, 0).left)
			assert.equal(pane.style.left, '20px')
			assert.equal(pane.style.right, 'auto')
		})

		it('the pane continues the component\'s VISUAL edge: the outset an active style declares widens it on both sides', async function() {
			// An active style that draws the field's edge OUTSIDE its box (Lift's
			// outer ring) declares how far in --pane_edge_outset; the pane's sides
			// must land on that edge, not on the box. The declaration is the
			// contract — the value is read from the node, never assumed.
			const portal = make_portal({ id:'pane_edge_outset' })
			portal.node.style.cssText = 'position:absolute; top:100px; left:40px; width:300px; height:50px; --pane_edge_outset:3px;'
			const declared = parseFloat(getComputedStyle(portal.node).getPropertyValue('--pane_edge_outset'))
			assert.equal(declared, 3, 'the node declares its outset')

			await portal.toggle_thesaurus_pane()
			const pane = portal.thesaurus_pane
			const edge = visual_edge(portal.node, declared)
			assert.equal(pane.style.left, edge.left, 'left edge = box − outset')
			assert.equal(pane.style.width, edge.width, 'width = box + both outsets')
			assert.equal(pane.style.left, '37px')
			assert.equal(pane.style.width, '306px')

			// and the edge is kept when the pane re-measures
			portal.node.style.top = '260px'
			window.dispatchEvent(new Event('scroll'))
			assert.equal(pane.style.left, edge.left, 'the outset survives a scroll')
		})

		it('a full destroy removes the body-level pane AND its area', async function() {
			const portal = make_portal({ id:'pane_destroy_cleanup' })
			await portal.toggle_thesaurus_pane()
			const pane = portal.thesaurus_pane
			const area = portal.thesaurus_area
			assert.equal(pane.parentNode, document.body)

			await portal.destroy(true, true, true)

			assert.equal(pane.parentNode, null,
				'the generic destroy only removes self.node; this pane is not inside it')
			assert.equal(area.status, 'destroyed',
				'the area is not in ar_instances; the component override owns it')
		})
	})


	// ─────────────────────────────────────────────────────────────────────────
	describe('the pane closes with the component blur, but a pick does not blur it', function() {

		it('deactivate_component for THIS component closes the pane', async function() {
			// The pane is a picker FOR the component; an open picker on a component the
			// operator has left is a stale surface over the rest of the form.
			const portal = make_portal({ id:'pane_closes_on_blur' })
			// the real init wires this subscription; the fixture wires only the piece
			// under test, from the same handler shape
			portal.events_tokens = []
			const handler = (component) => {
				if (component.id===portal.id && portal.thesaurus_pane
					&& !portal.thesaurus_pane.classList.contains('hide')) {
					// mirrors init(): close through the one close path
					portal.toggle_thesaurus_pane()
				}
			}
			const token = event_manager.subscribe('deactivate_component', handler)
			try {
				await portal.toggle_thesaurus_pane()
				assert.equal(pane_of(portal).classList.contains('hide'), false)

				event_manager.publish('deactivate_component', { id: portal.id })
				await new Promise(resolve => setTimeout(resolve, 0))

				assert.equal(pane_of(portal).classList.contains('hide'), true,
					'the component blurred; its picker must go with it')
			} finally {
				event_manager.unsubscribe(token)
			}
		})

		it('a mousedown INSIDE the pane never reaches the page (so it cannot blur the caller)', async function() {
			// The page deactivates the active component on any mousedown it receives.
			// A click on a term must therefore not propagate past the pane, or the
			// pick would close the picker — the autocomplete keeps its caller active
			// the same way, by stopping mousedown on its own node.
			const portal = make_portal({ id:'pane_click_keeps_focus' })
			await portal.toggle_thesaurus_pane()
			const pane = portal.thesaurus_pane

			let reached_body = 0
			const body_listener = () => { reached_body++ }
			document.body.addEventListener('mousedown', body_listener)
			try {
				const inner = document.createElement('span')
				pane.appendChild(inner)
				inner.dispatchEvent(new MouseEvent('mousedown', { bubbles:true, cancelable:true }))
			} finally {
				document.body.removeEventListener('mousedown', body_listener)
			}

			assert.equal(reached_body, 0, 'a pane mousedown must stop at the pane')
		})
	})


	// ─────────────────────────────────────────────────────────────────────────
	describe('the tree button reaches the PANE, and the browse window declares nothing', function() {

		it('a tree-view portal button opens the pane, not the separate window', async function() {
			// The button used to look for a `.thesaurus_pane` INSIDE the wrapper. The
			// pane is created on demand on document.body, so that query found nothing
			// and every click took the separate-window fallback — a window that then
			// declared the caller, was granted relation mode, and had no picker wired.
			const portal = make_portal({ id:'pane_button_route' })
			portal.context.view = 'tree'
			let toggled = 0
			let windowed = 0
			portal.toggle_thesaurus_pane	= async () => { toggled++; return true }
			portal.open_ontology_window		= () => { windowed++; return null }

			const button = buttons.render_button_tree_selector(portal)
			button.dispatchEvent(new MouseEvent('mousedown', { bubbles:true }))
			await new Promise(resolve => setTimeout(resolve, 0))

			assert.equal(toggled, 1, 'the pane is the picker surface')
			assert.equal(windowed, 0, 'the separate window is not the picker surface')
		})

		it('a NON-tree portal button keeps the browse window', async function() {
			const portal = make_portal({ id:'pane_button_browse' })
			portal.context.view = 'default'
			let toggled = 0
			let windowed = 0
			portal.toggle_thesaurus_pane	= async () => { toggled++; return true }
			portal.open_ontology_window		= () => { windowed++; return null }

			const button = buttons.render_button_tree_selector(portal)
			button.dispatchEvent(new MouseEvent('mousedown', { bubbles:true }))
			await new Promise(resolve => setTimeout(resolve, 0))

			assert.equal(toggled, 0)
			assert.equal(windowed, 1, 'six shipped nodes declare button_tree without a tree view')
		})

		it('the browse window carries NO picker_caller', function() {
			// A separately-opened area page has nothing that calls attach_picker. A
			// caller declared there makes the server grant relation mode to a tree with
			// no picker: every node reports "No picker is attached to this tree".
			const portal = make_portal({ id:'pane_window_no_caller' })
			let opened_url = null
			const original = window.open
			// open_window resizes/focuses what window.open returns, so hand it an
			// inert window-like object instead of null
			window.open = (url) => {
				opened_url = String(url)
				return { resizeTo(){}, moveTo(){}, focus(){}, close(){}, closed:false }
			}
			try {
				portal.open_ontology_window(null, null)
			} finally {
				window.open = original
			}

			assert.notEqual(opened_url, null, 'a window was requested')
			assert.equal(opened_url.includes('picker_caller'), false,
				'the browse window must not declare a caller it cannot wire')
		})
	})


	// ─────────────────────────────────────────────────────────────────────────
	describe('a failed build stays OPEN and states the reason', function() {

		it('the pane is not hidden, and carries an error node', async function() {
			// FAULT INJECTED AT THE MOUNT. The build's failure modes (a 403 the
			// principal cannot pass, a 409 target with no active hierarchy) need
			// server state this suite must not manufacture, so the throw is induced at
			// the seam the catch exists to protect — the mount into the pane. What is
			// asserted is the CATCH's contract, which is the part that regressed:
			// stay open, and say why.
			// with_pane so the node exists before the fault is injected into it
			const portal = make_portal({ id:'pane_failed_build', with_pane:true })
			const pane = pane_of(portal)
			pane.appendChild = () => { throw new Error('injected mount failure') }

			const result = await portal.toggle_thesaurus_pane()

			assert.equal(result, false, 'the build did not succeed')
			assert.equal(pane.classList.contains('hide'), false,
				'a failed build must leave the pane visible so its reason can be read')
			assert.notEqual(pane.querySelector('.thesaurus_pane_error'), null,
				'the refusal is told to the operator, not only to the console')
		})

		it('a component naming no record declares no picker and still explains itself', async function() {
			// picker_caller refuses without {section_tipo, section_id, tipo}; the
			// surface must not silently do nothing.
			const portal = make_portal({ id:'pane_no_record', section_id:null })

			const result = await portal.toggle_thesaurus_pane()
			const pane = pane_of(portal)

			assert.equal(result, false)
			assert.equal(pane.classList.contains('hide'), false)
		})
	})


	// ─────────────────────────────────────────────────────────────────────────
	describe('reuse is decided by the INSTANCE, never by a flag', function() {

		it('a DESTROYED area is rebuilt, not reused', async function() {
			// an area destroyed underneath the pane (a component destroy of the
			// previous mount, a page-level teardown) must be REPLACED on reopen.
			const portal = make_portal({
				id				: 'pane_destroyed_area',
				with_pane		: true,
				pane_child		: true,
				thesaurus_area	: { status:'destroyed' }
			})
			const pane = pane_of(portal)

			const destroyed = portal.thesaurus_area
			const result = await portal.toggle_thesaurus_pane()

			// A REBUILD must have happened. A flag-based reuse would have skipped it
			// and left the pane pointing at a tree that no longer exists — which is
			// exactly what every successful pick used to produce.
			assert.equal(result, true, 'the pane reopens on a fresh area')
			assert.notEqual(portal.thesaurus_area, destroyed,
				'the destroyed area must be REPLACED, never reused')
			assert.equal(portal.thesaurus_area.status!=='destroyed', true, 'a live area replaced it')
			assert.equal(portal.ar_instances.length, 0,
				'the area is NOT in ar_instances: refresh() would destroy it on every pick')
			assert.equal(pane.querySelector('.thesaurus_pane_error'), null)
		})

		it('the area SURVIVES the component refresh a pick triggers', async function() {
			// The defect: after ONE pick the panel went dark and had to be reopened.
			// refresh() destroys ar_instances; the pane's area must not be there.
			const portal = make_portal({ id:'pane_survives_refresh' })
			await portal.toggle_thesaurus_pane()
			const area = portal.thesaurus_area
			assert.notEqual(area, null, 'an area was built')
			assert.equal(portal.ar_instances.includes(area), false,
				'the area is owned by the pane, not by the refresh cycle')

			// what refresh() does to dependencies
			await portal.destroy(false, true, false)

			assert.notEqual(area.status, 'destroyed',
				'destroying DEPENDENCIES (the refresh path) must leave the pane area alive')
			assert.equal(pane_of(portal).classList.contains('hide'), false,
				'and the pane stays open — picking several terms is several clicks')
		})

		it('a LIVE area is reused: no rebuild, and the linked state is re-synced', async function() {
			let synced = 0
			const portal = make_portal({
				id				: 'pane_live_area',
				with_pane		: true,
				pane_child		: true,
				thesaurus_area	: { status:'built' }
			})
			portal.picker = { sync_linked: () => { synced++; return true } }
			const pane = pane_of(portal)

			const result = await portal.toggle_thesaurus_pane()

			assert.equal(result, true, 'a live area reopens')
			assert.equal(pane.classList.contains('hide'), false)
			assert.equal(synced, 1,
				'reopening must re-read the caller locators: they may have changed underneath')
			assert.equal(pane.querySelector('.thesaurus_pane_error'), null, 'nothing failed')
			assert.equal(portal.thesaurus_area.status, 'built', 'the same live area, no rebuild')
		})

		it('the AUTOCOMPLETE is HIDDEN while the tree is open, and restored on close', async function() {
			// The two input paths overlap in the component and the autocomplete's
			// datalist/settings panel paints over the tree, so one of them must step
			// aside. It must be HIDDEN, never destroyed: activate_autocomplete's fast
			// path is `autocomplete_active===true → show()`, so a teardown leaves the
			// component with no autocomplete on the next activation. The ontology
			// declaration is untouched; this is a runtime exclusion, and it is
			// REVERSIBLE.
			let hidden = 0
			let shown = 0
			const portal = make_portal({
				id				: 'pane_autocomplete_off',
				with_pane		: true,
				pane_child		: true,
				thesaurus_area	: { status:'built' }
			})
			portal.picker				= { sync_linked: () => true }
			portal.autocomplete_active	= true
			portal.autocomplete			= {
				hide: () => { hidden++; return true },
				show: () => { shown++;  return true }
			}

			await portal.toggle_thesaurus_pane() // open

			assert.equal(hidden, 1, 'the input steps aside for the tree')
			assert.equal(shown, 0)
			assert.equal(portal.autocomplete_active, true,
				'the service stays ACTIVE: destroying it breaks the next activation')
			assert.notEqual(portal.autocomplete, null, 'the instance survives')

			await portal.toggle_thesaurus_pane() // close

			assert.equal(shown, 1, 'closing the tree gives the input straight back')
		})

		it('ESC closes the pane, and stops there', async function() {
			const portal = make_portal({
				id				: 'pane_escape',
				with_pane		: true,
				pane_child		: true,
				thesaurus_area	: { status:'built' }
			})
			portal.picker = { sync_linked: () => true }
			const pane = pane_of(portal)

			await portal.toggle_thesaurus_pane()
			assert.equal(pane.classList.contains('hide'), false)

			let propagated = false
			document.addEventListener('keydown', () => { propagated = true })
			document.dispatchEvent(new KeyboardEvent('keydown', {
				key: 'Escape', bubbles: true, cancelable: true
			}))

			assert.equal(pane.classList.contains('hide'), true, 'ESC closes the picker')
			assert.equal(propagated, false,
				'while the tree is open ESC means "close the tree" and nothing else —'
				+ ' the component must not also be deactivated by the same keypress')
		})

		it('the ESC listener is dropped on close: one open must not leak one listener', async function() {
			const portal = make_portal({
				id				: 'pane_escape_cleanup',
				with_pane		: true,
				pane_child		: true,
				thesaurus_area	: { status:'built' }
			})
			portal.picker = { sync_linked: () => true }

			await portal.toggle_thesaurus_pane() // open
			assert.equal(typeof portal.thesaurus_pane_escape, 'function')
			await portal.toggle_thesaurus_pane() // close
			assert.equal(portal.thesaurus_pane_escape, null,
				'this surface is opened many times over a record life; each open must'
				+ ' remove its own document listener')
		})

		it('opening a SECOND picker closes the first: they would share one area', async function() {
			// The area instance key is (model, tipo, section_tipo, section_id, mode,
			// lang) — none of which varies between two callers on one record — so two
			// open panes resolve the SAME area and the second steals the first's tree
			// and linker. `id_variant` cannot be the fix: it CASCADES into every
			// section_record and component built under the area (section.js:1191),
			// which is what made the search panel's components build wrong.
			const first = make_portal({
				id:'pane_first',  with_pane:true, pane_child:true, thesaurus_area:{ status:'built' }
			})
			const second = make_portal({
				id:'pane_second', with_pane:true, pane_child:true, thesaurus_area:{ status:'built' }
			})
			first.picker	= { sync_linked: () => true }
			second.picker	= { sync_linked: () => true }

			await first.toggle_thesaurus_pane()
			assert.equal(pane_of(first).classList.contains('hide'), false)

			await second.toggle_thesaurus_pane()

			assert.equal(pane_of(second).classList.contains('hide'), false, 'the second opens')
			assert.equal(pane_of(first).classList.contains('hide'), true,
				'the first must be closed, not left sharing the area')
			assert.equal(first.thesaurus_pane_escape, null,
				'the closed picker also released its document listener')
		})

		it('toggling a live pane closes it without destroying the tree', async function() {
			const portal = make_portal({
				id				: 'pane_toggle_close',
				with_pane		: true,
				pane_child		: true,
				thesaurus_area	: { status:'built' }
			})
			portal.picker = { sync_linked: () => true }
			const pane = pane_of(portal)

			await portal.toggle_thesaurus_pane() // open
			const closed = await portal.toggle_thesaurus_pane() // close

			assert.equal(closed, false, 'closing answers false')
			assert.equal(pane.classList.contains('hide'), true)
			assert.notEqual(pane.firstChild, null,
				'the tree is kept so reopening is instant and its state survives')
		})
	})
})

// @license-end
