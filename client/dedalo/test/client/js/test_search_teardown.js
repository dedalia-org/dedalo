// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/

import { event_manager } from '../../../core/common/js/event_manager.js';
import {
	get_all_instances,
	get_instance,
	get_instance_by_id,
} from '../../../core/common/js/instances.js';
import { search } from '../../../core/search/js/search.js';
import { lang, section_id, section_tipo } from './elements.js';

/**
 * TEST_SEARCH_TEARDOWN
 * Removing a search filter node tears down every instance in its subtree
 * (P2-2 / CLI-19).
 *
 * The filter panel's GROUP close button removed the model node and the DOM node
 * and nothing else, while the ROW close button also spliced and destroyed. So a
 * removed group left every component instance inside it in the global registry
 * with its subscriptions alive, and `search.reset` then refreshed the orphans.
 *
 * `remove_model_node` is now THE teardown door: it walks the removed subtree,
 * splices each bound instance from `ar_instances` and destroys it. This suite
 * BUILDS the situation on the generic `test` TLD (real component instances on
 * the test3 playground, each holding a live subscription) and measures the
 * registry and the event table before and after — the audit's own repro.
 *
 * And `reset()` must REJECT, never hang, when an instance's refresh throws:
 * the old `new Promise(async …)` executor swallowed the throw and left
 * Promise.all waiting forever.
 */

describe('SEARCH_TEARDOWN', function () {
	this.timeout(30000);

	// make_search — a bare search controller with the model machinery only
	// (no caller, no DOM): the door under test needs `ar_instances` and the
	// node counter, nothing from init()
	const make_search = () => {
		const self = new search();
		self.id = `search_teardown_${Date.now()}`;
		self.ar_instances = [];
		self.model_node_counter = 0;
		self.events_tokens = [];
		return self;
	};

	// make_component — a REAL registered instance with one live subscription
	const make_component = async (suffix) => {
		const instance = await get_instance({
			model: 'component_input_text',
			tipo: 'test52',
			section_tipo: section_tipo,
			section_id: section_id,
			mode: 'search',
			lang: lang,
			id_variant: `search_teardown_${suffix}_${Date.now()}`,
		});
		// the kind of subscription a rendered filter row holds
		instance.events_tokens.push(event_manager.subscribe(`render_${instance.id}`, () => {}));
		return instance;
	};

	describe('remove_model_node tears down the whole subtree', () => {
		it('a group with two rows: instances and events return to baseline', async () => {
			const baseline_instances = get_all_instances().length;
			const baseline_events = event_manager.get_events().length;

			const self = make_search();
			const root = self.create_group_model_node('$and', null, null);
			const group = self.create_group_model_node('$or', root, null);

			const a = await make_component('a');
			const b = await make_component('b');
			self.ar_instances.push(a, b);
			self.create_component_model_node({ instance: a, parent_node: group });
			self.create_component_model_node({ instance: b, parent_node: group });

			// the situation is built: two more instances, two more events
			assert.equal(
				get_all_instances().length,
				baseline_instances + 2,
				'precondition: both registered',
			);
			// each instance subscribes its own init events plus the one added above
			assert.isAtLeast(
				event_manager.get_events().length,
				baseline_events + 2,
				'precondition: both subscribed',
			);
			assert.equal(self.ar_instances.length, 2);

			try {
				// the group close button's model call
				const removed = self.remove_model_node(group);
				assert.equal(removed, true);
				assert.equal(root.children.length, 0, 'the group left the model');

				// destroy is async inside the walk: let it settle
				await new Promise((resolve) => setTimeout(resolve, 50));

				assert.equal(self.ar_instances.length, 0, 'ar_instances no longer lists the orphans');
				assert.equal(get_instance_by_id(a.id), null, 'row a left the registry');
				assert.equal(get_instance_by_id(b.id), null, 'row b left the registry');
				assert.equal(get_all_instances().length, baseline_instances, 'registry back to baseline');
				assert.equal(
					event_manager.get_events().length,
					baseline_events,
					'event table back to baseline',
				);
			} finally {
				// safety net: never leave orphans for the next suite
				for (const instance of [a, b]) {
					if (get_instance_by_id(instance.id)) {
						await instance.destroy(true, true, true);
					}
				}
			}
		});

		it('a nested group is walked too', async () => {
			const baseline_instances = get_all_instances().length;

			const self = make_search();
			const root = self.create_group_model_node('$and', null, null);
			const outer = self.create_group_model_node('$or', root, null);
			const inner = self.create_group_model_node('$and', outer, null);

			const deep = await make_component('deep');
			self.ar_instances.push(deep);
			self.create_component_model_node({ instance: deep, parent_node: inner });

			try {
				self.remove_model_node(outer);
				await new Promise((resolve) => setTimeout(resolve, 50));
				assert.equal(
					get_instance_by_id(deep.id),
					null,
					'the instance two levels down was destroyed',
				);
				assert.equal(get_all_instances().length, baseline_instances);
				assert.equal(self.ar_instances.length, 0);
			} finally {
				if (get_instance_by_id(deep.id)) {
					await deep.destroy(true, true, true);
				}
			}
		});

		it('the row close path is idempotent: a second splice/destroy finds nothing', async () => {
			const self = make_search();
			const root = self.create_group_model_node('$and', null, null);
			const row = await make_component('row');
			self.ar_instances.push(row);
			const node = self.create_component_model_node({ instance: row, parent_node: root });

			try {
				self.remove_model_node(node);
				await new Promise((resolve) => setTimeout(resolve, 30));
				// what render_search's row handler does next
				const index = self.ar_instances.findIndex((instance) => instance.id === row.id);
				assert.equal(index, -1, 'the door already spliced it');
				assert.equal(get_instance_by_id(row.id), null);
				// a second destroy on the same instance is the base class's no-op
				const again = await row.destroy(true);
				assert.deepEqual(again, {}, 'double-destroy protection');
			} finally {
				if (get_instance_by_id(row.id)) {
					await row.destroy(true, true, true);
				}
			}
		});

		it('a detached node (no parent) is refused without touching anything', async () => {
			const self = make_search();
			const lone = await make_component('lone');
			self.ar_instances.push(lone);
			const node = self.create_component_model_node({ instance: lone, parent_node: null });
			try {
				assert.equal(self.remove_model_node(node), false);
				assert.notEqual(get_instance_by_id(lone.id), null, 'nothing destroyed');
				assert.equal(self.ar_instances.length, 1);
			} finally {
				await lone.destroy(true, true, true);
			}
		});
	}); //end describe remove_model_node

	describe('a stale preset leaf never blocks the panel (TODO-014)', () => {
		it('nonexistent tipo + wrong stored model: placeholders, the good leaf renders, the filter drops them, one repair save; a transient failure keeps its condition', async () => {
			const baseline_instances = get_all_instances().length;

			const self = make_search();
			const root = self.create_group_model_node('$and', null, null);
			self.filter_model = root;
			const leaf = (component_tipo, model) =>
				JSON.stringify([{ section_tipo: section_tipo, component_tipo, model, name: component_tipo }]);
			// spy the change path: the temp-preset repair save. Snapshot what the save
			// would serialize AT CALL TIME (proves the
			// pending-leaf counter: a premature save would miss the in-flight good leaf)
			const calls = [];
			self.update_state = async (options) => {
				const { filter } = self.parse_dom_to_json_filter({ mode: 'default' });
				calls.push({ state: options.state, paths: filter.$and.map((item) => JSON.stringify(item.path)) });
			};
			// the good leaf settles last; a transient failure (timeout/5xx) is not stale
			const transient = leaf('test53', 'component_input_text');
			const original_get_component_instance = self.get_component_instance;
			self.get_component_instance = async function (options) {
				if (JSON.stringify(options.path) === transient) {
					throw Object.assign(new Error('timeout'), { code: 'client.timeout' });
				}
				const result = await original_get_component_instance.call(this, options);
				if (options.component_tipo === 'test52' && options.model === 'component_input_text') {
					await new Promise((resolve) => setTimeout(resolve, 300));
				}
				return result;
			};

			const parent_div = document.createElement('div');
			parent_div.__node = root;
			document.body.appendChild(parent_div);

			const good = leaf('test52', 'component_input_text');

			try {
				// concurrent, as build_dom_group fires them
				const results = await Promise.all([
					// (a) a tipo the ontology does not hold: the server answers request.invalid_tipo
					self.build_search_component({ parent_div, path_plain: leaf('test999999', 'component_input_text'), section_id: 'search_1' }),
					// (b) a real tipo stored with another model: context.model answers component_input_text
					self.build_search_component({ parent_div, path_plain: leaf('test52', 'component_number'), section_id: 'search_1' }),
					self.build_search_component({ parent_div, path_plain: good, section_id: 'search_1' }),
					// (c) a transient failure: placeholder, but the condition is KEPT
					self.build_search_component({ parent_div, path_plain: transient, section_id: 'search_1', entries: [{ value: 'kept' }], q_operator: '=' }),
				]);
				assert.deepEqual(results, [true, true, true, true], 'nothing throws, every row resolves');

				const rows = [...parent_div.querySelectorAll(':scope > .search_component')];
				assert.equal(rows.length, 4, 'every row keeps its place');
				assert.ok(rows[0].querySelector('.invalid_component'), '(a) placeholder');
				assert.ok(rows[1].querySelector('.invalid_component'), '(b) placeholder');
				assert.equal(rows[2].querySelector('.invalid_component'), null, 'the good leaf renders');
				assert.ok(rows[3].querySelector('.invalid_component'), '(c) placeholder');

				for (const save_arguments of [undefined, 'false']) {
					const { filter } = self.parse_dom_to_json_filter({ mode: 'default', save_arguments });
					assert.deepEqual(
						filter.$and.map((item) => JSON.stringify(item.path)),
						[good, transient],
						`the stale leaves are dropped, the transient one kept (save_arguments ${save_arguments})`,
					);
				}
				const { filter: kept_filter } = self.parse_dom_to_json_filter({ mode: 'default' });
				assert.deepEqual(kept_filter.$and[1].q, [{ value: 'kept', id: 1 }], '(c) its stored q survives');
				assert.equal(kept_filter.$and[1].q_operator, '=', '(c) its stored q_operator survives');
				assert.deepEqual(
					calls,
					[{ state: 'changed', paths: [good, transient] }],
					'one repair save, after the slow good leaf settled (it is in the saved filter)',
				);
				assert.equal(self.ar_instances.length, 1, 'only the good leaf is held');

				// the placeholder's close button only removes its row
				rows[0].querySelector('.button.close').click();
				assert.equal(parent_div.querySelectorAll(':scope > .search_component').length, 3);
			} finally {
				for (const instance of self.ar_instances) {
					await instance.destroy(true, true, true);
				}
				parent_div.remove();
			}
			assert.equal(get_all_instances().length, baseline_instances, 'no discarded instance leaked');
		});
	}); //end describe stale preset leaf

	describe('reset never hangs', () => {
		it('a throwing refresh REJECTS reset (no async Promise executor)', async () => {
			const self = make_search();
			// a fake filter row whose refresh throws
			self.ar_instances.push({
				id: 'throwing_row',
				data: { entries: ['x'] },
				refresh: async () => {
					throw new Error('refresh exploded');
				},
			});

			const outcome = await Promise.race([
				self.reset().then(
					() => 'resolved',
					(error) => `rejected:${error.message}`,
				),
				new Promise((resolve) => setTimeout(() => resolve('hung'), 2000)),
			]);
			assert.equal(
				outcome,
				'rejected:refresh exploded',
				'the throw must surface as a rejection, not a hang',
			);
		});
	}); //end describe reset
}); //end describe SEARCH_TEARDOWN
