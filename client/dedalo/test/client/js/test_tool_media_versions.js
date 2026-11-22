// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/
'use strict';

/**
 * TEST_TOOL_MEDIA_VERSIONS
 * Client-side coverage for the media-version management tool.
 *
 * The tool's deeper build/render path needs a host section with a live media
 * component (component_av / component_image / component_pdf) plus a running tool
 * context API, none of which is guaranteed in the headless harness. This suite
 * therefore asserts the reliable, fixture-free contract that every tool shares:
 *   - the module exports a constructor named exactly as its model,
 *   - construction seeds the documented instance properties,
 *   - the prototype is wired with the common + tool-specific lifecycle methods.
 *
 * This is the locked client template (layer 1: module-load + construct + wiring).
 */

import {tool_media_versions} from '../../../tools/tool_media_versions/js/tool_media_versions.js'
import {
	render_build_version,
	live_component_job,
	release_component_busy_gears
} from '../../../tools/tool_media_versions/js/render_tool_media_versions.js'



/**
* ONE AV BUILD PER COMPONENT, IN THE PANEL (A1-01, owner ruling 3).
* The server refuses a build of EVERY tier of an av component while a
* component-scoped job of it is live (media.build_running). The panel learns
* that from get_record_jobs (`scope: 'component'` on the activity row) and must
* grey every other tier's gear — titled from the tool label — instead of
* offering a click that is guaranteed to be refused. Fixture-free: the cells
* are rendered against a stub panel holding the jobs the server would answer.
*/
const COMPONENT_TIPO = 'test94'

const live_job = function(over) {
	return Object.assign({
		job_id			: 'a101_job',
		label			: '404',
		record			: {section_tipo: 'test3', section_id: 1, component_tipo: COMPONENT_TIPO},
		also_qualities	: ['audio'],
		scope			: 'component',
		status			: 'running',
		progress		: null,
		started_at		: Date.now()
	}, over || {})
}

const stub_panel = function(jobs) {
	const calls = {build: 0, followers: []}
	const self = {
		main_element	: {
			tipo	: COMPONENT_TIPO,
			model	: 'component_av',
			context	: {features: {default_quality: '404'}}
		},
		record_jobs		: jobs,
		get_tool_label	: (name) => name==='component_busy' ? 'LABEL component_busy' : null,
		job_followers	: {follow: (job_id, handlers) => { calls.followers.push({job_id, handlers}) }},
		build_version	: async () => { calls.build++; return {result: true} },
		refresh			: () => {},
		node			: document.createElement('div')
	}
	return {self, calls}
}

const gear_of = function(cell) {
	return cell.querySelector('.button.gear')
}



describe('TOOL_MEDIA_VERSIONS CLIENT TEST', function() {

	this.timeout(10000)

	it('module exports the tool constructor', function() {
		assert.equal(typeof tool_media_versions, 'function', 'expected tool_media_versions to be a constructor function')
	})

	it('construct seeds the documented instance properties', function() {
		const instance = new tool_media_versions()

		assert.equal(typeof instance, 'object', 'expected instance to be an object')
		// documented null-seeded common + tool-specific properties
		assert.equal(instance.id, null, 'expected id null')
		assert.equal(instance.model, null, 'expected model null')
		assert.equal(instance.mode, null, 'expected mode null')
		assert.equal(instance.node, null, 'expected node null')
		assert.equal(instance.ar_instances, null, 'expected ar_instances null')
		assert.equal(instance.events_tokens, null, 'expected events_tokens null')
		assert.equal(instance.status, null, 'expected status null')
		assert.equal(instance.main_element, null, 'expected main_element null')
		assert.equal(instance.caller, null, 'expected caller null')
		assert.equal(instance.timer, null, 'expected timer null')
		assert.equal(instance.main_element_quality, null, 'expected main_element_quality null')
	})

	it('prototype is wired with the lifecycle methods', function() {
		// common lifecycle delegated from tool_common / common
		assert.equal(typeof tool_media_versions.prototype.render, 'function', 'expected render wired')
		assert.equal(typeof tool_media_versions.prototype.destroy, 'function', 'expected destroy wired')
		assert.equal(typeof tool_media_versions.prototype.refresh, 'function', 'expected refresh wired')
		// render mode delegated to render_tool_media_versions
		assert.equal(typeof tool_media_versions.prototype.edit, 'function', 'expected edit wired')
		// tool-specific overrides defined on the module
		assert.equal(typeof tool_media_versions.prototype.init, 'function', 'expected init defined')
		assert.equal(typeof tool_media_versions.prototype.build, 'function', 'expected build defined')
		// tool-specific API client methods
		assert.equal(typeof tool_media_versions.prototype.get_files_info, 'function', 'expected get_files_info defined')
		assert.equal(typeof tool_media_versions.prototype.delete_quality, 'function', 'expected delete_quality defined')
		assert.equal(typeof tool_media_versions.prototype.build_version, 'function', 'expected build_version defined')
		assert.equal(typeof tool_media_versions.prototype.conform_headers, 'function', 'expected conform_headers defined')
		assert.equal(typeof tool_media_versions.prototype.rotate, 'function', 'expected rotate defined')
		assert.equal(typeof tool_media_versions.prototype.sync_files, 'function', 'expected sync_files defined')
		assert.equal(typeof tool_media_versions.prototype.delete_version, 'function', 'expected delete_version defined')
		// RECORD-SCOPED JOB DISCOVERY (2026-08-12). Without this method the panel
		// falls back to click-local state, which is precisely the bug it replaced:
		// a transcode started by tool_upload — or by another operator — was
		// invisible here, and the tier's empty cell was indistinguishable from a
		// tier that had never been built.
		assert.equal(typeof tool_media_versions.prototype.get_record_jobs, 'function', 'expected get_record_jobs defined')
		// The legacy per-job poll is kept for callers that hold a job id directly.
		assert.equal(typeof tool_media_versions.prototype.get_job_status, 'function', 'expected get_job_status defined')
	})

})



describe('TOOL_MEDIA_VERSIONS: a busy av component greys every tier (A1-01)', function() {

	it('a live component-scoped job greys EVERY other tier, titled from the tool label', function() {
		const {self} = stub_panel([live_job()])
		for (const quality of ['1080', '720', '240', 'thumb']) {
			const gear = gear_of(render_build_version(quality, self))
			assert.ok(gear, `expected a gear on tier ${quality}`)
			assert.ok(gear.classList.contains('component_busy'), `expected tier ${quality} greyed`)
			assert.equal(gear.getAttribute('aria-disabled'), 'true', `expected tier ${quality} aria-disabled`)
			assert.ok(gear.title.startsWith('LABEL component_busy'), `expected the tool label as title on ${quality}, got: ${gear.title}`)
			assert.ok(gear.title.includes('(404)'), `expected the building tier named on ${quality}`)
		}
	})

	it('the building tier and its companion show the progress readout, no gear', function() {
		const {self} = stub_panel([live_job()])
		for (const quality of ['404', 'audio']) {
			const cell = render_build_version(quality, self)
			assert.equal(gear_of(cell), null, `expected no gear on the building tier ${quality}`)
			assert.ok(cell.querySelector('.job_progress'), `expected the progress readout on ${quality}`)
		}
	})

	it('a click on a greyed gear asks the server nothing', async function() {
		const {self, calls} = stub_panel([live_job()])
		const gear = gear_of(render_build_version('1080', self))
		gear.click()
		await new Promise(resolve => setTimeout(resolve, 0))
		assert.equal(calls.build, 0, 'expected no build_version call from a greyed gear')
		assert.equal(self.node.classList.contains('loading'), false, 'expected no loading state')
	})

	it('a free component offers every gear (no job, unscoped, other component, finished)', function() {
		const cases = {
			'no job'			: [],
			'unscoped job'		: [live_job({scope: null})],
			'other component'	: [live_job({record: {section_tipo: 'test3', section_id: 1, component_tipo: 'test95'}})],
			'finished job'		: [live_job({status: 'completed'})]
		}
		for (const [name, jobs] of Object.entries(cases)) {
			const {self} = stub_panel(jobs)
			assert.equal(live_component_job(self), null, `${name}: expected the component free`)
			const gear = gear_of(render_build_version('1080', self))
			assert.ok(gear, `${name}: expected a gear`)
			assert.equal(gear.classList.contains('component_busy'), false, `${name}: expected the gear offered`)
			assert.equal(gear.hasAttribute('aria-disabled'), false, `${name}: expected no aria-disabled`)
			assert.ok(gear.title.includes('1080'), `${name}: expected the build title, got: ${gear.title}`)
		}
	})

	it('a FAILED holder gives the greyed gears back (no re-render on that path)', function() {
		const {self, calls} = stub_panel([live_job()])
		const building	= render_build_version('404', self)
		const other		= render_build_version('1080', self)
		self.node.appendChild(building)
		self.node.appendChild(other)
		const gear = gear_of(other)
		assert.ok(gear.classList.contains('component_busy'), 'expected the other tier greyed first')

		const follower = calls.followers.find(entry => entry.job_id==='a101_job')
		assert.ok(follower, 'expected the building tier to follow its job')
		follower.handlers.on_done({errors: ['a101: encode failed']})

		assert.equal(gear.classList.contains('component_busy'), false, 'expected the gear released')
		assert.equal(gear.hasAttribute('aria-disabled'), false, 'expected aria-disabled removed')
		assert.ok(gear.title.includes('1080'), `expected the build title restored, got: ${gear.title}`)
		assert.ok(building.querySelector('.build_error'), 'expected the failed tier to keep its reason')
	})

	it('release_component_busy_gears is a no-op without a node', function() {
		assert.doesNotThrow(() => release_component_busy_gears({node: null}), 'expected no throw on a panel without a node')
		assert.doesNotThrow(() => release_component_busy_gears({}), 'expected no throw on a panel never rendered')
	})
})

// @license-end
