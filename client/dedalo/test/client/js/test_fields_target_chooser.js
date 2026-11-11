// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global it, describe, assert */
/*eslint no-undef: "error"*/

import {
	get_target_choices,
	render_components_list,
} from '../../../core/common/js/render_common.js';

// The FIELDS picker (render_common.js render_components_list, shared by search and
// tool_export) drilled a relation into `target_section_tipo[0]` ONLY: a relation
// pointing to several sections (tch199 → every toponymy + tchi1) hid every other
// target's fields. The drilled level now carries a section chooser built from the
// server's `target_section_groups` (section_elements_context.ts
// groupTargetSections). Backend-free: synthetic contexts, a stub caller.

// two virtual siblings of one real section (testv1, testv2 → testreal) + one real
const groups = [
	{
		tipo: 'testreal',
		label: 'Thesaurus',
		members: [
			{ tipo: 'testv1', label: 'España' },
			{ tipo: 'testv2', label: 'France' },
		],
	},
	{ tipo: 'testother', label: 'Immovables', members: [{ tipo: 'testother', label: 'Immovables' }] },
];

const portal_element = {
	model: 'component_portal',
	tipo: 'test3p1',
	label: 'Production place',
	section_tipo: 'test3',
	target_section_tipo: ['testv1', 'testv2', 'testother'],
	target_section_groups: groups,
};

// the fields each target section offers (the stub server)
const fields_of = {
	testv1: [
		{ model: 'section', tipo: 'testv1', label: 'España' },
		{ model: 'section_group', tipo: 'testg', label: 'General' },
		{ model: 'component_input_text', tipo: 'testterm', label: 'Term', section_tipo: 'testv1' },
	],
	testv2: [
		{ model: 'section', tipo: 'testv2', label: 'France' },
		{ model: 'section_group', tipo: 'testg', label: 'General' },
		{ model: 'component_input_text', tipo: 'testterm', label: 'Term', section_tipo: 'testv2' },
	],
	testother: [
		{ model: 'section', tipo: 'testother', label: 'Immovables' },
		{ model: 'section_group', tipo: 'testg', label: 'General' },
		{ model: 'component_input_text', tipo: 'testname', label: 'Name', section_tipo: 'testother' },
	],
};

const make_caller = (group_target_sections) => {
	const requested = [];
	return {
		requested,
		group_target_sections,
		calculate_component_path: (element, path) =>
			path.concat([
				{ section_tipo: element.section_tipo, component_tipo: element.tipo, name: element.label },
			]),
		get_section_id: () => 'tmp_export_1',
		get_section_elements_context: async ({ section_tipo }) => {
			requested.push(section_tipo);
			return fields_of[section_tipo];
		},
		on_dragstart: () => {},
	};
};

const root_section = { model: 'section', tipo: 'test3', label: 'Object' };
// a field row lives in its group: real contexts always open one before the components
const root_group = { model: 'section_group', tipo: 'test3g1', label: 'Identification' };
const root_elements = [root_section, root_group, portal_element];

/** Render the root, drill into the portal, return the drilled column. */
const drill = async (caller) => {
	const target_div = document.createElement('div');
	document.body.appendChild(target_div);
	render_components_list({
		self: caller,
		section_tipo: 'test3',
		target_div,
		path: [],
		section_elements: root_elements,
	});
	const row = target_div.querySelector('li.has_subquery');
	row.click();
	// the click handler awaits the (stub) fetch
	for (
		let i = 0;
		i < 10 && !target_div.querySelector('.target_list_container .component_label');
		i++
	) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return { target_div, drilled: target_div.querySelector('ul.target_list_container') };
};

const settle = async (node, selector, text) => {
	for (let i = 0; i < 20; i++) {
		const found = node.querySelector(selector);
		if (found && found.textContent === text) return found;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	return node.querySelector(selector);
};

describe('FIELDS_TARGET_CHOOSER : get_target_choices', () => {
	it('family mode (tool_export): one choice per REAL section, drilled through its first member', () => {
		const choices = get_target_choices(portal_element, { group_target_sections: true });
		assert.deepEqual(
			choices.map((el) => [el.section_tipo, el.label]),
			[
				['testv1', 'Thesaurus (2)'],
				['testother', 'Immovables'],
			],
		);
		assert.equal(choices[0].title, 'España, France', 'the family names its members');
	});

	it('member mode (search): one choice per section, labelled by its family', () => {
		const choices = get_target_choices(portal_element, {});
		assert.deepEqual(
			choices.map((el) => [el.section_tipo, el.group_label]),
			[
				['testv1', 'Thesaurus'],
				['testv2', 'Thesaurus'],
				['testother', null],
			],
		);
	});

	it('no groups from the server: every raw target is still offered (not [0] only)', () => {
		const { target_section_groups, ...bare } = portal_element;
		assert.ok(target_section_groups);
		const choices = get_target_choices(bare, { group_target_sections: true });
		assert.deepEqual(
			choices.map((el) => el.section_tipo),
			['testv1', 'testv2', 'testother'],
		);
	});

	it('a family with no member is ignored', () => {
		const choices = get_target_choices(
			{
				...portal_element,
				target_section_groups: [{ tipo: 'x', label: 'x', members: [] }, groups[1]],
			},
			{ group_target_sections: true },
		);
		assert.deepEqual(
			choices.map((el) => el.section_tipo),
			['testother'],
		);
	});
});

describe('FIELDS_TARGET_CHOOSER : the drilled level offers every target', () => {
	it('a single-target relation renders no chooser', async () => {
		const caller = make_caller(true);
		const target_div = document.createElement('div');
		document.body.appendChild(target_div);
		try {
			render_components_list({
				self: caller,
				section_tipo: 'test3',
				target_div,
				path: [],
				section_elements: [
					root_section,
					root_group,
					{
						...portal_element,
						target_section_tipo: ['testother'],
						target_section_groups: undefined,
					},
				],
			});
			target_div.querySelector('li.has_subquery').click();
			const name = await settle(
				target_div,
				'.target_list_container .section_bar_section_name',
				'Immovables',
			);
			assert.ok(name, 'the plain level name renders');
			assert.equal(target_div.querySelector('select.section_chooser'), null);
		} finally {
			target_div.remove();
		}
	});

	it('switching the chooser loads the other section and the drag path names it', async () => {
		const caller = make_caller(true);
		const { target_div, drilled } = await drill(caller);
		try {
			const select = drilled.querySelector('li.section_bar_label select.section_chooser');
			assert.ok(select, 'the drilled level carries the chooser');
			assert.equal(select.options.length, 2);
			assert.equal(select.options[select.selectedIndex].textContent, 'Thesaurus (2)');
			assert.deepEqual(caller.requested, ['testv1']);

			// the first family's field path: portal hop + the member's field
			const term = drilled.querySelector('li.component_label');
			assert.equal(term.textContent, 'Term');
			assert.deepEqual(
				term.path.map((el) => [el.section_tipo, el.component_tipo]),
				[
					['test3', 'test3p1'],
					['testv1', 'testterm'],
				],
			);

			// switch to the other real section
			select.value = select.options[1].value;
			select.dispatchEvent(new Event('change'));
			const name = await settle(drilled, 'li.component_label', 'Name');
			assert.equal(name.textContent, 'Name', "the other section's fields render");
			assert.deepEqual(caller.requested, ['testv1', 'testother']);
			assert.deepEqual(
				name.path.map((el) => [el.section_tipo, el.component_tipo]),
				[
					['test3', 'test3p1'],
					['testother', 'testname'],
				],
			);
			const reselect = drilled.querySelector('select.section_chooser');
			assert.equal(
				reselect.options[reselect.selectedIndex].textContent,
				'Immovables',
				'the chooser shows the choice',
			);
		} finally {
			target_div.remove();
		}
	});

	it('drilling back into the field reopens the last chosen section', async () => {
		const caller = make_caller(true);
		const { target_div, drilled } = await drill(caller);
		try {
			const select = drilled.querySelector('select.section_chooser');
			select.value = select.options[1].value;
			select.dispatchEvent(new Event('change'));
			await settle(drilled, 'li.component_label', 'Name');

			target_div.querySelector('li.has_subquery').click();
			await new Promise((resolve) => setTimeout(resolve, 0));
			const name = await settle(drilled, 'li.component_label', 'Name');
			assert.equal(name.textContent, 'Name');
			assert.equal(caller.requested.at(-1), 'testother');
		} finally {
			target_div.remove();
		}
	});

	it('a click on the chooser does not close the level', async () => {
		const caller = make_caller(true);
		const { target_div, drilled } = await drill(caller);
		try {
			drilled.querySelector('select.section_chooser').click();
			assert.ok(drilled.querySelector('li.component_label'), 'the level stays');
		} finally {
			target_div.remove();
		}
	});
});
