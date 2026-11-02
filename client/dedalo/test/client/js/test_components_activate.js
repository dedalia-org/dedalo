// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert, page_globals */
/*eslint no-undef: "error"*/

import {
	elements
} from './elements.js'
import {get_instance} from '../../../core/common/js/instances.js'
import {ui} from '../../../core/common/js/ui.js'
import {pause} from '../../../core/common/js/utils/util.js'
import {owned_target} from './owned_target.js'



// SAVE SETTLE — why every case waits for the save its own deactivate launched.
// ui.component.deactivate() saves pending changed_data FIRE-AND-FORGET: it calls
// component.change_value() without awaiting it (deliberate — a curator leaving a
// field must not block on the network). This suite sets changed_data on every
// component and then deactivates it, so each it() used to END with its save
// still in flight, and the NEXT it() paid for it: measured on the suite server,
// component_check_box's module GETs and its get_data were held until
// component_av's save answered (the whole check_box case lasted exactly as long
// as that save), and the same bleed shows after security_access (→ select) and
// select_lang (→ svg). On a loaded hosted runner a slow save landed inside the
// following case's 5000 ms budget: 'component_check_box. Activation — Timeout of
// 5000ms exceeded' (gh run 35843092386, instance tier), a red charged to a
// component that did nothing wrong. The server log of that run shows a test3/1
// save fired by this suite (select_lang, test89) taking 10.3 s.
// That multi-second save was an ENGINE defect, fixed at its root 2026-09-26:
// the select_lang save echo enumerated all ~21.7k lg1 records as its datalist
// (2.2 MB) instead of the project languages the read serves (a few KB, ~15 ms).
// Gate: test/unit/select_family_echo_datalist_native.test.ts. The wait below
// stays — it is what makes each case own its save, not a timing allowance.
//
// The real condition is polled, bounded: change_value() raises `changing`
// synchronously, before its first await, and clears it in its `finally`; save()
// holds `saving` for the request. Both false = the save settled (or was never
// started: test_save:false, save_on_deactivate:false, a no-change skip). A save
// that never settles is still a failure — named, with the component — just no
// longer someone else's. Same shape as test_additional_text_area's editor wait.
const SAVE_SETTLE_MS = 8000

const wait_for_save_settled = async function(instance, max_ms = SAVE_SETTLE_MS) {
	const started = Date.now()
	while (Date.now() - started < max_ms) {
		if (instance.changing!==true && instance.saving!==true) {
			return Date.now() - started
		}
		await pause(25)
	}
	throw new Error(`${instance.model} (${instance.tipo}) save launched by deactivate did not settle after ${max_ms} ms (changing: ${instance.changing}, saving: ${instance.saving})`)
}


describe("COMPONENTS ACTIVATE", async function() {

	this.timeout(5000);

	const container = document.getElementById('content');
	container.addEventListener('click', function(e) {
		e.preventDefault()

	})

	for (let i = 0; i < elements.length; i++) {

		// if (i!=0) continue

		const element = elements[i]
			  element.mode = 'edit'
			  element.view = 'default'

		describe(`component: ${element.model} ${element.mode} ${element.view} :`,  function() {

			// OWNED TARGET: the deactivate save below lands on the SHARED record
			// (element.section_id). An element whose value is a link read back from
			// the other side (owned_target.js) points at a record built here and
			// swept after, with the shared record's value restored first.
			const target = (element.test_save!==false && element.owned_target)
				? owned_target(element, element.section_id)
				: null
			let target_section_id = null
			if (target) {
				before(async function() {
					target_section_id = await target.setup()
				})
				after(async function() {
					await target.teardown()
				})
			}

			// const component_instance = await get_instance(element)
			// await component_instance.build(true)
			// const node = await component_instance.render()
			// console.log('node:', node);

			// TEST activation
				it(`${element.model}. Activation`, async function() {

					const options = {
						id_variant		: Math.random() + '-' + Math.random(),
						lang			: element.lang,
						model			: element.model,
						section_id		: element.section_id,
						section_tipo	: element.section_tipo,
						tipo			: element.tipo,
						mode			: 'edit',
						view			: 'default'
					}

					const instance = await get_instance_rendered(options)

					// pointer content_data
					assert( instance.node, `wrapper DOES NOT exists`)

					// pointer content_data
					assert( instance.node.content_data, `wrapper pointer to content_data DOES NOT exists`)

					// pointer content_value
					// assert( instance.node.content_data[0], `wrapper pointer to content_data DOES NOT exists`)

					// check selection
					const wrapper = instance.node

					// activate by click event
					// wrapper.click()
					wrapper.dispatchEvent(new Event('mousedown'));
					// section_id is a read-only badge: activation is refused (ui.component.activate)
					if (element.model==='component_section_id') {
						assert( !wrapper.classList.contains('active'), `component_section_id must NOT activate`)
						assert( instance.active!==true, `component_section_id instance must NOT be active`)
						return
					}
					assert( wrapper.classList.contains('active'), `wrapper activated styles are NOT found`)
					assert( instance.active===true, `instance property active is NOT set as true`)
					assert( page_globals.component_active===instance, `page_globals.component_active is NOT set correctly`)
					container.prepend(wrapper)

					// skip save compare test on some components like password
					if (element.test_save===false) {

						console.log(`* Skip non test save element ${elements[i].model}:`, elements[i]);

					}else{
						// console.log('instance.data:', instance.data);
						// const entries = instance.data.entries
						// 	? instance.data.entries[0]
						// 	: null
						// console.log(`${element.model} entries:`, entries);

						// new_value. Calculated as random proper data for current component
						const new_value = element.new_value(element.new_value_params, target_section_id)
						// console.log(`${element.model} new_value:`, new_value);

						// change data
							const changed_data_item = Object.freeze({
								action	: 'update',
								key		: 0,
								value	: (Array.isArray(new_value) ? new_value[0] : new_value)
							})

						// fix instance changed_data
							instance.set_changed_data(changed_data_item)

						// console.log('instance.data.changed_data:', instance.data.changed_data);
					}

					// deactivate current component
					await ui.component.deactivate(page_globals.component_active)
					assert( !wrapper.classList.contains('active'), `wrapper activated styles are NOT removed`)
					assert( instance.active===false, `instance property active is NOT set as false`)
					assert( page_globals.component_active===null, `page_globals.component_active is NOT reset (expected null)`)

					// the save deactivate launched belongs to THIS case (see SAVE
					// SETTLE above). It gets its own window: mocha's timer is
					// re-armed from now, so activation keeps its 5000 ms and the
					// save phase is bounded by SAVE_SETTLE_MS — the poll throws its
					// named error first, the extra second is only the margin.
					this.timeout(SAVE_SETTLE_MS + 1000)
					await wait_for_save_settled(instance)
				});

		})//end describe(element.model, function() {

	}//end for (let i = 0; i < elements.length; i++)
});


// COMPONENTS FOCUS ON ACTIVATION — the selection flow keeps the element the user
// targeted. Regressions it pins (all measured with real clicks in the browser):
//  - an input activating only on focus (email, number) was blurred by the
//    deactivate of the PREVIOUS active component: the click landed on the body;
//  - activate() focused the FIRST input after the click had focused another one;
//  - a click on the label of the ALREADY active component left the focus on the
//    body (build_wrapper_edit refocus_active), while a portal is left alone.
// A synthetic mousedown runs the handlers but never moves the focus, so every
// case performs the browser default itself: mousedown, then focus().
describe("COMPONENTS FOCUS ON ACTIVATION", async function() {

	this.timeout(10000);

	const container	= document.getElementById('content');
	const by_model	= (model) => elements.find(el => el.model===model)
	const mousedown	= (node) => {
		const e = new MouseEvent('mousedown', {bubbles: true, cancelable: true, button: 0})
		node.dispatchEvent(e)
		return e
	}
	const first_input = (instance) => instance.node.content_data[0].querySelector('input, select')

	const mounted = []
	const mount = async (model) => {
		const element = by_model(model)
		const instance = await get_instance_rendered({
			id_variant		: 'focus-' + Math.random(),
			lang			: element.lang,
			model			: element.model,
			section_id		: element.section_id,
			section_tipo	: element.section_tipo,
			tipo			: element.tipo,
			mode			: 'edit',
			view			: 'default'
		})
		container.prepend(instance.node)
		mounted.push(instance)
		return instance
	}

	afterEach(async function() {
		if (page_globals.component_active) {
			await ui.component.deactivate(page_globals.component_active)
		}
		while (mounted.length) {
			const instance = mounted.pop()
			instance.node?.remove()
			await instance.destroy(true, true, true)
		}
	})

	for (const model of ['component_email', 'component_number']) {

		it(`${model}. Input click while another component is active keeps the focus`, async function() {
			const previous	= await mount('component_input_text')
			const instance	= await mount(model)
			await ui.component.activate(previous, false)
			first_input(previous).focus()

			const input = first_input(instance)
			mousedown(input)
			input.focus()
			await pause(300)

			assert(instance.active===true, `${model} is NOT active`)
			assert(document.activeElement===input, `${model} input lost the focus to: ${document.activeElement?.tagName}`)
		});

		it(`${model}. Focus arriving with another component active (Tab) keeps the focus`, async function() {
			// the previous one does not deactivate itself on Tab (portal-like)
			const previous	= await mount('component_input_text')
			const instance	= await mount(model)
			await ui.component.activate(previous, false)

			const input = first_input(instance)
			input.focus()
			await pause(300)

			assert(instance.active===true, `${model} is NOT active`)
			assert(page_globals.component_active===instance, `page_globals.component_active is NOT ${model}`)
			assert(document.activeElement===input, `${model} input lost the focus to: ${document.activeElement?.tagName}`)
		});

		it(`${model}. Label click on the active component focuses the first input`, async function() {
			const instance = await mount(model)
			await ui.component.activate(instance, false)
			document.activeElement?.blur()

			const e = mousedown(instance.node.label)

			assert(e.defaultPrevented===true, `mousedown default NOT prevented (the browser would blur the input)`)
			assert(document.activeElement===first_input(instance), `first input NOT focused: ${document.activeElement?.tagName}`)
		});
	}

	it(`component_number. activate() keeps a focused element that is not the first input`, async function() {
		const instance	= await mount('component_number')
		const other		= ui.create_dom_element({
			element_type	: 'button',
			parent			: instance.node.content_data[0]
		})
		// activation from a mousedown runs BEFORE the browser moves the focus
		await ui.component.activate(instance)
		other.focus()
		await pause(300)

		assert(document.activeElement===other, `activate() moved the focus to: ${document.activeElement?.tagName}`)
	});

	it(`component_portal. Label click on the active portal is left alone`, async function() {
		const instance = await mount('component_portal')
		await ui.component.activate(instance, false)

		const e = mousedown(instance.node.label)

		assert(e.defaultPrevented===false, `portal mousedown default was prevented`)
	});

	it(`component_email. Toolbar mousedown on the active component is left alone`, async function() {
		const instance = await mount('component_email')
		await ui.component.activate(instance, false)
		const button = instance.node.querySelector('.buttons_container .button')
		assert(button, `email toolbar button NOT found`)

		const e = mousedown(button)

		assert(e.defaultPrevented===false, `toolbar mousedown default was prevented`)
	});
});



async function get_instance_rendered(options) {

	const component_instance =  await get_instance(options)
	await component_instance.build(true)
	await component_instance.render()
	// console.log('node:', node);

	return component_instance
}



// @license-end
