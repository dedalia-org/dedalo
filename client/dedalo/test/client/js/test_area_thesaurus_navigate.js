// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/
'use strict';



/**
* TEST_AREA_THESAURUS_NAVIGATE
* The gate for the thesaurus / ontology area's navigate(): the one door every
* search and every "Show all" goes through.
*
* WHAT IT PINS, and each is a defect that shipped (the ontology search "gets
* stuck until the page is reloaded"):
*
*  - ONE FAILED SEARCH DOES NOT KILL THE NEXT. refresh() refuses an instance whose
*    status is not 'rendered'. A refused read left 'initialized', a throw in build
*    'building', a throw in the tree render 'rendering' — so every later search was
*    silently ignored. navigate must always hand back a 'rendered' area.
*  - AN OVERLAPPING NAVIGATION IS NOT DROPPED. "Show all" during a search hit the
*    same status gate and vanished. Navigations run one after another, in order.
*
* Backend-free: the instance is built on the REAL prototype with refresh stubbed,
* so gutting navigate fails this file instead of a mock agreeing with itself.
*/

// imports
	import {area_thesaurus} from '../../../core/area_thesaurus/js/area_thesaurus.js'



// make_area — an area reduced to what navigate reads
	const make_area = (refresh) => {

		const self = Object.create(area_thesaurus.prototype)

		self.status		= 'rendered'
		self.node		= { content_data : document.createElement('div') }
		self.refresh	= refresh

		return self
	}



describe('AREA_THESAURUS NAVIGATE (search / show all door)', function() {

	for (const failed_status of ['initialized', 'building', 'rendering']) {
		it(`a navigation that ends '${failed_status}' leaves the area 'rendered'`, async function() {

			const area = make_area(async function() {
				this.status = failed_status
				if (failed_status!=='initialized') {
					throw new Error('injected failure')
				}
				return false
			})

			const result = await area.navigate({})

			assert.strictEqual(result, true, 'navigate resolves, never rejects')
			assert.strictEqual(area.status, 'rendered', 'the next refresh() is not refused')
			assert.isFalse(area.node.content_data.classList.contains('loading'), 'loading is removed')
		})
	}

	it('the search after a failed one runs', async function() {

		let calls = 0
		const area = make_area(async function() {
			calls++
			if (calls===1) {
				this.status = 'building'
				throw new Error('injected failure')
			}
		})

		await area.navigate({})
		await area.navigate({})

		assert.strictEqual(calls, 2)
		assert.strictEqual(area.status, 'rendered')
	})

	it('an overlapping navigation is queued, not dropped, and runs in order', async function() {

		const order = []
		let running = 0
		const area = make_area(async function() {
			running++
			assert.strictEqual(running, 1, 'never two refreshes at once')
			await new Promise(resolve => setTimeout(resolve, 10))
			running--
		})

		await Promise.all([
			area.navigate({ callback : () => order.push('search') }),
			area.navigate({ callback : () => order.push('show_all') })
		])

		assert.deepEqual(order, ['search', 'show_all'])
	})

	it('a destroyed area is not revived', async function() {

		const area = make_area(async function() {
			this.status = 'destroyed'
		})

		await area.navigate({})

		assert.strictEqual(area.status, 'destroyed')
	})
})



// @license-end
