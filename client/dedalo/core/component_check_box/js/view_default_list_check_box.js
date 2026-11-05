// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/

// import
import { ui } from '../../common/js/ui.js';
import { render_join } from '../../common/js/utils/render_escape.js';
import { bind_edit_in_list } from '../../component_common/js/component_common.js';

/**
 * VIEW_DEFAULT_LIST_CHECK_BOX
 * Read-only list view for component_check_box.
 *
 * Displays the currently selected checkbox values as a plain text string
 * inside a standard list wrapper. When the user clicks the wrapper, the
 * component transitions to edit mode — inline if the wrapper is wide enough
 * (>= component_check_box.minimum_width_px = 100 px), or inside a modal
 * dialog otherwise.
 *
 * This view is activated by render_list_component_check_box when
 * context.view is 'default' (or absent). It is the primary list
 * representation shown in record grids, portal autocomplete results,
 * and the section list table.
 *
 * Exported symbol: view_default_list_check_box
 *   .render(self) → Promise<HTMLElement>
 */
export const view_default_list_check_box = () => true; //end view_default_list_check_box

/**
 * RENDER
 * Build the read-only list wrapper node for component_check_box.
 *
 * The returned element is a <div> produced by ui.component.build_wrapper_list,
 * carrying CSS classes that identify the component type, tipo, section_tipo,
 * mode ('list'), and view ('default'). If any entries are present they are
 * joined into a single string and inserted as a <span> child by the builder.
 *
 * Data shape consumed from `self`:
 *   self.data.entries  {string[]} - Array of already-resolved display labels
 *                                   for the currently selected options. Each
 *                                   element is a human-readable term string
 *                                   (resolved by the server from the target
 *                                   locators); the client does not re-resolve
 *                                   them here. May be empty ([]) when nothing
 *                                   is selected.
 *   self.context.fields_separator {string} - Separator inserted between label
 *                                   strings (e.g. ', ' or ' | '). Defined in
 *                                   the ontology component properties.
 *
 * Click behaviour:
 *   A single click on the wrapper calls activate_edit_in_list with mode 'auto'.
 *   That helper reads the wrapper's rendered width and compares it against
 *   self.minimum_width_px (100 px for component_check_box). If the wrapper is
 *   wide enough, the component switches to inline edit (view 'line'); otherwise
 *   a modal dialog is opened. The click event is stopped from bubbling so
 *   parent containers (e.g. a row in a list table) do not also react.
 *   Read-only and dataframe contexts are already handled inside
 *   activate_edit_in_list, which returns false without opening the editor.
 *
 * @param {Object} self - component_check_box instance providing context and data.
 * @returns {Promise<HTMLElement>} The constructed list wrapper element.
 */
view_default_list_check_box.render = async (self) => {
	// short vars
	const data = self.data || {};
	const entries = data.entries || [];
	// Join resolved label strings; fields_separator comes from ontology properties (e.g. ', ').
	const value_string = render_join(
		entries,
		self.context.fields_separator,
		self.context.render_class,
	);

	// wrapper
	// build_wrapper_list creates a <div> with component/model/tipo/section_tipo CSS classes
	// and, when value_string is non-empty, inserts it inside a <span> child.
	const wrapper = ui.component.build_wrapper_list(self, {
		value_string: value_string,
	});

	// click handler for edit mode activation (auto: inline if wide enough, modal otherwise)
	bind_edit_in_list(self, wrapper, { mode: 'auto' });

	return wrapper;
}; //end render

// @license-end
