// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/
'use strict';

/**
* TEST_CLIENT_XSS_ESCAPES
* A RECORD / USER value is TEXT at the sinks CodeQL found (alert 7930, alert 7940, alert 7941)
* and at the speaker binding dialog of tool_transcription (people records),
* and a query-string / typed-query key cannot re-parent an object (alert 8032,
* alert 8033, alert 8105).
*
* WHY THESE ASSERTIONS. Each case drives the SHIPPED code path with the payload
* `<img src=x onerror=…>` and asserts the outcome in the DOM: no <img> element
* exists and the exact payload is the node's textContent. A sink that went
* back to inner_html / innerHTML concatenation parses the payload into an
* <img> and fails here (the static census is render_escape_tripwire's).
* Backend-free: no request leaves the page.
*/

import {vector_editor} from '../../../core/component_image/js/vector_editor.js'
import {search} from '../../../core/search/js/search.js'
import {extract_node_fields} from '../../../core/section/js/build_graph_data.js'
import {url_vars_to_object} from '../../../core/common/js/utils/index.js'
import {service_autocomplete} from '../../../core/services/service_autocomplete/js/service_autocomplete.js'
import {tool_transcription} from '../../../tools/tool_transcription/js/tool_transcription.js'
import {ui} from '../../../core/common/js/ui.js'



const XSS = '<img src=x onerror="window.__xss_fired=true">'



describe('CLIENT XSS ESCAPES (record values are text)', function() {

	this.timeout(10000)

	it('vector_editor: a layer named with markup renders as TEXT in the delete dialog (alert 7930)', async function() {

		const editor = new vector_editor()
		editor.stage = {
			getCurrentDrawing	: () => ({ getLayerName : () => 'layer_2' }),
			clearSelection		: () => {},
			setCurrentLayer		: () => {}
		}
		editor.active_layer = { layer_id : 1 }
		const self = { id : 'xss_vector_' + Date.now(), events_tokens : [], ar_layers : [] }

		const layer_li = editor.render_layer_row(self, {
			layer_id		: 2,
			name			: 'layer_2',
			user_layer_name	: XSS
		})
		document.body.appendChild(layer_li)

		let body = null
		try {
			layer_li.querySelector('.layer_delete').click()
			body = document.querySelector('.content.delete_layer')
			assert.ok(body, 'the delete dialog body expected in the document')
			assert.equal(body.querySelector('img'), null, 'the layer name must not be parsed as markup')
			assert.ok(body.textContent.includes('Layer: ' + XSS), 'the exact layer name expected as text')
			assert.equal(window.__xss_fired, undefined, 'no payload may run')
		} finally {
			// close the modal the click opened, and the row
			const modal = (body && body.closest('dd-modal')) || window.modal || null
			if (modal) {
				if (typeof modal.close==='function') await modal.close()
				if (modal.isConnected) modal.remove()
			}
			layer_li.remove()
			editor.destroy()
		}
	})

	it('render_search: a filter path name with markup is prepended as TEXT (alert 7940)', async function() {

		const self = new search()
		self.id					= 'xss_search_' + Date.now()
		self.ar_instances		= []
		self.model_node_counter	= 0
		self.events_tokens		= []
		// no backend: the row renders its 'Invalid component' fallback
		self.get_component_instance = async () => null

		const parent_div = document.createElement('div')
		const label_add = document.createElement('span')
		label_add.className = 'label_add'
		label_add.innerHTML = '<b class="own">own</b>'
		parent_div.appendChild(label_add)
		document.body.appendChild(parent_div)

		try {
			const path = [
				{ name : XSS, section_tipo : 'test3', component_tipo : 'test80', model : 'component_portal' },
				{ name : 'leaf', section_tipo : 'test3', component_tipo : 'test52', model : 'component_input_text' }
			]
			const result = await self.build_search_component({
				parent_div	: parent_div,
				path_plain	: JSON.stringify(path),
				section_id	: 'xss_row'
			})
			assert.equal(result, true, 'precondition: the row builds')
			assert.equal(label_add.querySelector('img'), null, 'the path name must not be parsed as markup')
			assert.ok(label_add.textContent.startsWith(XSS + ' '), 'the exact path name expected as leading text')
			assert.ok(label_add.querySelector('b.own'), 'the label\'s own markup survives (no innerHTML round-trip)')
			assert.equal(window.__xss_fired, undefined, 'no payload may run')
		} finally {
			parent_div.remove()
		}
	})

	it('build_graph_data: a field value is reduced to its text (one parse, entities decoded) (alert 7941)', function() {

		const datum = {
			context	: [],
			data	: [{
				section_tipo	: 'test3',
				section_id		: 1,
				tipo			: 'test52',
				debug_model		: 'component_input_text',
				entries			: ['a &amp; <b>b</b>']
			}]
		}
		const fields = extract_node_fields(datum, 'test3', 1, {})
		assert.equal(fields.length, 1)
		// the old regex strip left the entity encoded: 'a &amp; b'
		assert.equal(fields[0].value, 'a & b', 'the value expected as decoded text')
	})

	it('url_vars_to_object: a __proto__ key is an ordinary own key (alert 8032/alert 8033)', function() {

		const vars = url_vars_to_object('?__proto__=a&__proto__=b&x=1')
		assert.equal(Object.getPrototypeOf(vars), Object.prototype, 'the object must keep its prototype')
		assert.ok(Object.prototype.hasOwnProperty.call(vars, '__proto__'), '__proto__ expected as an own key')
		assert.deepEqual(Object.getOwnPropertyDescriptor(vars, '__proto__').value, ['a', 'b'])
		assert.equal(vars.x, '1')
	})

	it('service_autocomplete: the query cache is a Map, never a plain object (alert 8105)', function() {

		const service = new service_autocomplete()
		assert.ok(service.search_cache instanceof Map, 'search_cache expected as a Map')
		service.search_cache.set('__proto__', ['hit'])
		assert.deepEqual(service.search_cache.get('__proto__'), ['hit'], 'a __proto__ query is an ordinary key')
		assert.equal(Object.getPrototypeOf(service.search_cache), Map.prototype)
	})

	it('tool_transcription: a person name / role with markup is TEXT in the speaker binding dialog', async function() {

		const self = Object.create(tool_transcription.prototype)
		self.get_tool_label				= () => null
		self.transcription_component	= { data : {}, tags_to_html : () => '' }

		const opened = self.assign_speakers({
			value	: '[TC_00:00:01.000_TC][person-a-1-P1-data::data] hello',
			persons	: [{ full_name : XSS, role : XSS, tag : '[person-a-2-X-data::data]', data : {} }]
		})
		const body = document.querySelector('.transcription_speakers_map')
		try {
			assert.ok(body, 'the speaker dialog expected in the document')
			const options = [...body.querySelectorAll('option')]
			assert.equal(options.length, 2, 'the unassigned option plus the one person')
			assert.equal(body.querySelector('img'), null, 'the person must not be parsed as markup')
			assert.equal(options[1].textContent, XSS + ' (' + XSS + ')', 'the exact name (role) expected as text')
			assert.equal(window.__xss_fired, undefined, 'no payload may run')
		} finally {
			const modal = (body && body.closest('dd-modal')) || window.modal || null
			if (modal && typeof modal.close==='function') await modal.close()
			if (modal && modal.isConnected) modal.remove()
		}
		assert.equal(await opened, null, 'closing the dialog binds nothing')
	})

	it('ui.confirm: a string header is TEXT, never parsed', async function() {

		const pending = ui.confirm({ header : 'Duplicate ' + XSS, body : 'x' })
		const header = document.querySelector('dd-modal .header .label') || [...document.querySelectorAll('.header .label')].pop()
		try {
			assert.ok(header, 'the confirm header expected in the document')
			assert.equal(header.querySelector('img'), null, 'the header must not be parsed as markup')
			assert.ok(header.textContent.includes('Duplicate ' + XSS), 'the exact header expected as text')
		} finally {
			const modal = (header && header.closest('dd-modal')) || window.modal || null
			if (modal && typeof modal.close==='function') await modal.close()
			if (modal && modal.isConnected) modal.remove()
		}
		assert.equal(await pending, false, 'a dismissed confirm resolves false')
	})
})
