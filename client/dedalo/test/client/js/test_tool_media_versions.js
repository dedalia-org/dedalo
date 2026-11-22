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

const stub_panel = function(jobs, element_over) {
	const calls = {build: 0, followers: []}
	const self = {
		main_element	: Object.assign({
			tipo	: COMPONENT_TIPO,
			model	: 'component_av',
			context	: {features: {default_quality: '404'}}
		}, element_over || {}),
		record_jobs		: jobs,
		get_tool_label	: (name) => name==='component_busy' ? 'LABEL component_busy' : null,
		job_followers	: {follow: (job_id, handlers) => { calls.followers.push({job_id, handlers}) }},
		build_version	: async () => { calls.build++; return {ok: true, job_id: 'a101_own', data: {}} },
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


describe('TOOL_MEDIA_VERSIONS: the busy state is immediate, per lang and accessible (A1-01 review L6)', function() {

	const tick = () => new Promise(resolve => setTimeout(resolve, 0))

	/** Render the given tiers into the panel's node; quality → cell. */
	const render_grid = function(self, qualities) {
		const cells = {}
		for (const quality of qualities) {
			cells[quality] = render_build_version(quality, self)
			self.node.appendChild(cells[quality])
		}
		return cells
	}

	const reason_of = function(gear) {
		const id = gear.getAttribute('aria-describedby')
		return id ? gear.parentNode.querySelector('#' + id) : null
	}

	it('THIS browser\'s accepted av build greys the other tiers at once; its failure gives them back', async function() {
		const {self, calls} = stub_panel([])
		const cells = render_grid(self, ['404', '1080', '720'])
		gear_of(cells['404']).click()
		await tick()
		assert.equal(calls.build, 1, 'expected the build asked once')
		for (const quality of ['1080', '720']) {
			const gear = gear_of(cells[quality])
			assert.ok(gear.classList.contains('component_busy'), `expected ${quality} greyed at once`)
			assert.equal(gear.getAttribute('aria-disabled'), 'true', `expected ${quality} aria-disabled`)
			const reason = reason_of(gear)
			assert.ok(reason, `expected ${quality} to name its reason through aria-describedby`)
			assert.ok(reason.textContent.startsWith('LABEL component_busy'), `expected the tool label, got: ${reason.textContent}`)
			assert.ok(reason.textContent.includes('(404)'), 'expected the building tier named')
		}

		const follower = calls.followers.find(entry => entry.job_id==='a101_own')
		assert.ok(follower, 'expected the started build followed')
		await follower.handlers.on_done({errors: ['a101: encode failed']})
		for (const quality of ['1080', '720']) {
			const gear = gear_of(cells[quality])
			assert.equal(gear.classList.contains('component_busy'), false, `expected ${quality} released`)
			assert.equal(gear.hasAttribute('aria-describedby'), false, `expected ${quality} describedby removed`)
			assert.equal(cells[quality].querySelector('.component_busy_reason'), null, `expected ${quality} reason node removed`)
		}
	})

	it('a per-lang job greys only its own lang\'s panel (the server keys the hold by lang)', function() {
		const translatable = (lang) => ({lang, context: {features: {default_quality: '404'}, translatable: true}})
		const spa_job = live_job({record: {section_tipo: 'test3', section_id: 1, component_tipo: COMPONENT_TIPO, lang: 'lg-spa'}})

		const eng = stub_panel([spa_job], translatable('lg-eng')).self
		assert.equal(live_component_job(eng), null, 'expected the lg-eng panel free')
		assert.equal(gear_of(render_build_version('1080', eng)).classList.contains('component_busy'), false, 'expected lg-eng offered')
		assert.ok(gear_of(render_build_version('404', eng)), 'expected lg-eng\'s building tier offered, not shown as building')

		const spa = stub_panel([spa_job], translatable('lg-spa')).self
		assert.ok(live_component_job(spa), 'expected the lg-spa panel busy')
		assert.ok(gear_of(render_build_version('1080', spa)).classList.contains('component_busy'), 'expected lg-spa greyed')

		// An untranslatable panel (lg-nolan) matches the untranslatable job (lang null) only.
		const nolan = stub_panel([live_job({record: {section_tipo: 'test3', section_id: 1, component_tipo: COMPONENT_TIPO, lang: null}})], {lang: 'lg-nolan'}).self
		assert.ok(live_component_job(nolan), 'expected the untranslatable panel busy')
		assert.equal(live_component_job(stub_panel([spa_job], {lang: 'lg-nolan'}).self), null, 'expected a per-lang job not to hold the untranslatable panel')
	})

	it('the gears are keyboard buttons: Enter / Space build a free tier, a greyed one asks nothing', async function() {
		const free = stub_panel([])
		const gear = gear_of(render_build_version('1080', free.self))
		assert.equal(gear.getAttribute('role'), 'button', 'expected role=button')
		assert.equal(gear.getAttribute('tabindex'), '0', 'expected focusable')
		gear.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await tick()
		assert.equal(free.calls.build, 1, 'expected Enter to build')
		const other = gear_of(render_build_version('720', free.self))
		other.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', bubbles: true}))
		await tick()
		assert.equal(free.calls.build, 2, 'expected Space to build')

		const busy = stub_panel([live_job()])
		const greyed = gear_of(render_build_version('1080', busy.self))
		assert.equal(greyed.getAttribute('tabindex'), '0', 'expected a greyed gear still focusable (its reason is readable)')
		assert.ok(reason_of(greyed)?.textContent.startsWith('LABEL component_busy'), 'expected the reason through aria-describedby')
		greyed.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await tick()
		assert.equal(busy.calls.build, 0, 'expected no build from a greyed gear')
	})
})

describe('TOOL_MEDIA_VERSIONS: one build per press, named once (A1-01 second review F7/F8)', function() {

	const tick = () => new Promise(resolve => setTimeout(resolve, 0))

	/** A panel whose build request stays OUT until `answer()` is called. */
	const pending_panel = function() {
		const {self, calls} = stub_panel([])
		let answer = () => {}
		self.build_version = () => {
			calls.build++
			return new Promise(resolve => {
				answer = () => resolve({ok: false, error: {code: 'media.build_running'}})
			})
		}
		self.build_version_answer = () => answer()
		return {self, calls}
	}

	it('a held key (keydown auto-repeat) builds once', async function() {
		const {self, calls} = stub_panel([])
		const gear = gear_of(render_build_version('1080', self))
		gear.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', repeat: true, bubbles: true}))
		gear.dispatchEvent(new KeyboardEvent('keydown', {key: ' ', repeat: true, bubbles: true}))
		await tick()
		assert.equal(calls.build, 0, 'expected an auto-repeated keydown to ask nothing')
		gear.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await tick()
		assert.equal(calls.build, 1, 'expected the press itself to build')
	})

	it('a second click or key press while the request is out asks nothing; once answered, the gear works again', async function() {
		const {self, calls} = pending_panel()
		const gear = gear_of(render_build_version('1080', self))
		gear.click()
		gear.click()
		gear.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}))
		await tick()
		assert.equal(calls.build, 1, 'expected ONE request while it is out')
		self.build_version_answer()
		await tick()
		await tick()
		gear.click()
		await tick()
		assert.equal(calls.build, 2, 'expected the gear to work again after the answer')
		self.build_version_answer()
	})

	it('the gear is NAMED by its action; a greyed gear\'s reason is its description only', function() {
		const free = gear_of(render_build_version('1080', stub_panel([]).self))
		const name = free.getAttribute('aria-label')
		assert.ok(name && name.includes('1080'), `expected the action as the name, got: ${name}`)
		const greyed = gear_of(render_build_version('1080', stub_panel([live_job()]).self))
		assert.equal(greyed.getAttribute('aria-label'), name, 'expected the same action name while greyed')
		assert.equal(greyed.getAttribute('aria-label').includes('LABEL component_busy'), false, 'expected the reason NOT in the name')
		const id = greyed.getAttribute('aria-describedby')
		assert.ok(id, 'expected the reason as the description')
		assert.ok(greyed.parentNode.querySelector('#' + id).textContent.startsWith('LABEL component_busy'), 'expected the reason text')
	})
})

// @license-end
