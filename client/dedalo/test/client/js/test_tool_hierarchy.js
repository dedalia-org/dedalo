// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_HIERARCHY
 * Client-side coverage for the Hierarchy Tool.
 *
 * The tool's deeper render/open path needs a host section with a configured
 * hierarchy1 record plus the lazily-resolved form component instances
 * (hierarchy4-9, hierarchy109), none of which is guaranteed in the headless
 * harness. This suite therefore asserts the reliable, fixture-free contract
 * that every tool shares:
 *   - the module exports a constructor named exactly as its model,
 *   - construction seeds the documented instance properties,
 *   - the prototype is wired with the common + tool-specific lifecycle methods.
 *
 * This is the locked client template (layer 1: module-load + construct + wiring).
 *
 * Plus the fixture-free REBUILD POLICY painter (HIER-REBUILD,
 * WC-2026-11-10-hierarchy-rebuild-ownership): paint_rebuild_policy over a
 * hand-built "Force to create" control — a refused rebuild disables and
 * unchecks the checkbox and names the server's `reason` beside it.
 */

import {tool_hierarchy} from '../../../tools/tool_hierarchy/js/tool_hierarchy.js'
import {paint_rebuild_policy} from '../../../tools/tool_hierarchy/js/render_tool_hierarchy.js'



describe('TOOL_HIERARCHY CLIENT TEST', function() {

	this.timeout(10000)

	it('module exports the tool constructor', function() {
		assert.equal(typeof tool_hierarchy, 'function', 'expected tool_hierarchy to be a constructor function')
	})

	it('construct seeds the documented instance properties', function() {
		const instance = new tool_hierarchy()

		assert.equal(typeof instance, 'object', 'expected instance to be an object')
		// documented null-seeded common + tool-specific properties
		assert.equal(instance.id, null, 'expected id null')
		assert.equal(instance.model, null, 'expected model null')
		assert.equal(instance.mode, null, 'expected mode null')
		assert.equal(instance.node, null, 'expected node null')
		assert.equal(instance.ar_instances, null, 'expected ar_instances null')
		assert.equal(instance.status, null, 'expected status null')
		assert.equal(instance.main_element, null, 'expected main_element null')
		assert.equal(instance.type, null, 'expected type null')
		assert.equal(instance.caller, null, 'expected caller null')
	})

	it('prototype is wired with the lifecycle methods', function() {
		// common lifecycle delegated from tool_common / common
		assert.equal(typeof tool_hierarchy.prototype.render, 'function', 'expected render wired')
		assert.equal(typeof tool_hierarchy.prototype.destroy, 'function', 'expected destroy wired')
		assert.equal(typeof tool_hierarchy.prototype.refresh, 'function', 'expected refresh wired')
		// render mode delegated to render_tool_hierarchy
		assert.equal(typeof tool_hierarchy.prototype.edit, 'function', 'expected edit wired')
		// tool-specific overrides defined on the module
		assert.equal(typeof tool_hierarchy.prototype.init, 'function', 'expected init defined')
		assert.equal(typeof tool_hierarchy.prototype.build, 'function', 'expected build defined')
		assert.equal(typeof tool_hierarchy.prototype.generate_virtual_section, 'function', 'expected generate_virtual_section defined')
	})

	it('construct seeds the rebuild policy slots', function() {
		const instance = new tool_hierarchy()
		assert.equal(instance.rebuild_policy, null, 'expected rebuild_policy null')
		assert.equal(instance.force_to_create_control, null, 'expected force_to_create_control null')
	})

	describe('paint_rebuild_policy', function() {

		// a "Force to create" control as render_tool_hierarchy builds it: label + checkbox in a container
		const make_self = function(policy, labels) {
			const container	= document.createElement('div')
			const label		= document.createElement('label')
			const checkbox	= document.createElement('input')
			checkbox.type		= 'checkbox'
			checkbox.checked	= true
			label.appendChild(checkbox)
			container.appendChild(label)
			return {
				container,
				rebuild_policy			: policy,
				force_to_create_control	: {label, checkbox},
				get_tool_label			: (key) => labels[key]
			}
		}
		const notes = (self) => self.container.querySelectorAll(':scope > .rebuild_refused')

		it('a refused rebuild disables + unchecks the checkbox and names the reason', function() {
			const text = 'zz refused: another hierarchy record declares this TLD'
			const self = make_self({allowed: false, reason: 'not_sole_declarer'}, {rebuild_refused_not_sole_declarer: text})
			paint_rebuild_policy(self)
			const {label, checkbox} = self.force_to_create_control
			assert.equal(checkbox.disabled, true, 'expected the checkbox disabled')
			assert.equal(checkbox.checked, false, 'expected the checkbox unchecked')
			assert.equal(label.classList.contains('disabled'), true, 'expected the label marked disabled')
			assert.equal(label.title, text, 'expected the reason as the label title')
			assert.equal(notes(self).length, 1, 'expected one reason note')
			assert.equal(notes(self)[0].textContent, text, 'expected the reason label as the note')
		})

		it('an unknown label falls back to a sentence naming the reason', function() {
			const self = make_self({allowed: false, reason: 'ontology_package'}, {})
			paint_rebuild_policy(self)
			assert.equal(notes(self).length, 1, 'expected one reason note')
			assert.include(notes(self)[0].textContent, 'ontology_package', 'expected the reason named')
		})

		it('repainting replaces the note; an allowed rebuild re-enables the control', function() {
			const self = make_self({allowed: false, reason: 'core'}, {rebuild_refused_core: 'zz core'})
			paint_rebuild_policy(self)
			paint_rebuild_policy(self)
			assert.equal(notes(self).length, 1, 'expected exactly one note after two paints')

			self.rebuild_policy = {allowed: true, reason: null}
			paint_rebuild_policy(self)
			const {label, checkbox} = self.force_to_create_control
			assert.equal(checkbox.disabled, false, 'expected the checkbox enabled')
			assert.equal(label.classList.contains('disabled'), false, 'expected no disabled mark')
			assert.equal(label.hasAttribute('title'), false, 'expected no title')
			assert.equal(notes(self).length, 0, 'expected no note')
		})

		it('no policy yet (inspect not answered) paints nothing', function() {
			const self = make_self(null, {})
			paint_rebuild_policy(self)
			assert.equal(self.force_to_create_control.checkbox.disabled, false, 'expected the checkbox untouched')
			assert.equal(notes(self).length, 0, 'expected no note')
		})
	})

})

// @license-end
