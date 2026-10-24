// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, SHOW_DEBUG */
/*eslint no-undef: "error"*/

/**
* RENDER_TS_DIALOGS
* Modal dialog builders for thesaurus-node (ts_object) destructive actions.
*
* Currently exports a single dialog: render_delete_record_dialog, which
* presents the user with a confirmation modal before permanently deleting a
* thesaurus term. The dialog surface includes:
*   - A relation-list panel (collapsed by default) so the operator can review
*     incoming links to the node before committing the delete.
*   - A "Delete diffusion records" checkbox that propagates the intent to the
*     diffusion layer via self.delete_diffusion_records (read by delete_term).
*   - A hard block when the node still has descriptor children, preventing
*     orphaned sub-trees.
*
* Dependencies:
*   - ui.js              — DOM helpers and the <dd-modal> Web Component wrapper.
*   - events.js          — when_in_viewport / dd_request_idle_callback for
*                          deferred focus management after paint.
*   - render_common_section.js — render_relation_list for the relation panel.
*   - ts_object.js (caller) — provides self.delete_term() and self.caller.
*/

// imports
	import {ui} from '../../common/js/ui.js'
	import {when_in_viewport, dd_request_idle_callback} from '../../common/js/events.js'
	import {render_relation_list} from '../../section/js/render_common_section.js'



/**
* RENDER_DELETE_RECORD_DIALOG
* Builds and opens the "Delete term" confirmation modal for a thesaurus node.
*
* The dialog has three mutually-exclusive footer states:
*   1. Insufficient permissions (self.permissions < 2) — returns false immediately,
*      no modal is built.
*   2. Node has descriptor children — footer shows a warning message and no
*      delete button; the operator must remove all children first.
*   3. Node is deletable — footer shows the "Delete resource and all links" button
*      plus a "Delete diffusion records" checkbox.
*
* Deletion flow (state 3):
*   a. A browser confirm() dialog asks for a second acknowledgement.
*   b. self.delete_diffusion_records is written from the checkbox state before
*      the call so that ts_object.prototype.delete_term can read it.
*   c. delete_term() creates a transient section instance, calls section.delete_section(),
*      destroys the ts_object instance and reclaims its DOM node, then returns a
*      boolean indicating success.
*   d. On success the captured caller.refresh() is triggered (local, no network
*      re-fetch) and the modal is closed.
*
* Side-effects:
*   - Writes self.delete_diffusion_records on the ts_object instance. This flag is
*     consumed by ts_object.prototype.delete_term and is reset on every dialog open.
*   - Calls modal.close() via closure over the const modal declared after the
*     conditional block. The click handler captures modal via JS closure — this is
*     intentional; the reference is only needed after modal construction completes.
*
* @param {Object} options
* @param {Object} options.self                  - The ts_object instance owning this node.
* @param {number|string} options.section_id     - Numeric record ID of the thesaurus term to delete.
* @param {string} options.section_tipo          - Ontology tipo of the term's section (e.g. 'dd256').
* @param {boolean} options.has_descriptor_children - True when the node still has child descriptor
*                                                    nodes; blocks deletion when set.
* @returns {boolean} false when permissions are insufficient; true after the modal is opened.
*/
export const render_delete_record_dialog = function (options) {

	// options
		const self						= options.self
		const section_id				= options.section_id
		const section_tipo				= options.section_tipo
		const has_descriptor_children	= options.has_descriptor_children

	// invalid permissions
	// self.permissions mirrors the server-resolved integer (0–3); write access requires >= 2.
		if (self.permissions<2) {
			return false
		}

	// header
	// Shows "Delete ID: <id> [<section_tipo>]" using the localized delete label.
		const header = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'header'
		})
		// built as nodes: no value is spliced into markup
		const header_label = ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'label',
			text_content	: (get_label.delete || 'Delete') + ` ID: ${section_id} `,
			parent			: header
		})
		ui.create_dom_element({
			element_type	: 'span',
			class_name		: 'note',
			text_content	: `[${section_tipo}]`,
			parent			: header_label
		})

	// body
	// Starts with a non-breaking space so the layout engine reserves height
	// before the async relation list is injected.
		const body = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'body content',
			inner_html		: ' '
		})

	// relation_list
	// Build the collapsible relations panel and splice it into the body in place of
	// the temporary placeholder. render_relation_list returns a fully-wired container
	// node; using replaceWith avoids an extra wrapper level.
		const relation_list_placeholder = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'relation_list_placeholder',
			parent			: body
		})
		const relation_list = render_relation_list({
			self			: self,
			section_id		: section_id,
			section_tipo	: section_tipo
		})
		relation_list_placeholder.replaceWith(relation_list);

	// footer
		const footer = ui.create_dom_element({
			element_type	: 'div',
			class_name		: 'footer content'
		})

	if (has_descriptor_children) {

		// Deletion blocked: inform the user and disable all action buttons.
		// The 'left' class aligns the warning text flush-left in the footer.
		ui.create_dom_element({
			element_type	: 'div',
			inner_html		: 'Sorry. It is not possible to delete an element with children. Please remove all children before deleting.',
			class_name		: 'content warning',
			parent			: footer
		})
		footer.classList.add('left')

	}else{

		// button_delete (Deletes real target record)
			// button_delete
			// The 'danger remove' CSS classes apply the red destructive-action style
			// from the design system.
				const button_delete = ui.create_dom_element({
					element_type	: 'button',
					class_name		: 'danger remove',
					text_content	: get_label.delete_resource_and_links || 'Delete resource and all links',
					parent			: footer
				})
				/**
				* FN_CLICK_UNLINK_AND_DELETE
				* Click handler for the "Delete resource and all links" button.
				* Requires a second browser confirm() acknowledgement, then delegates to
				* ts_object.prototype.delete_term which orchestrates the server-side
				* delete and subsequent instance/DOM cleanup.
				*
				* (!) self.caller is captured BEFORE delete_term() is awaited because
				* delete_term() calls self.destroy(), which nulls self.caller as part of
				* the teardown sequence. Accessing self.caller after the await would return null.
				*
				* (!) modal.close() is called via the outer-scope closure reference. At this
				* point in the execution, const modal has already been initialised because
				* the click can only fire after the modal is rendered.
				*/
				const fn_click_unlink_and_delete = async function(e) {
					e.stopPropagation()

					// stop if the user don't confirm 1
					if (!confirm(get_label.are_you_sure_to_delete_this_record || 'Sure?')) {
						return
					}

					footer.classList.add('loading')

					// capture caller before delete: delete_term destroys self
					// (nulls self.caller in the process)
					const caller = self.caller

					// delete the record and pointers to it
					const deleted = await self.delete_term({
						section_tipo	: section_tipo,
						section_id		: section_id
					})

					footer.classList.remove('loading')

					if (!deleted) {
						return
					}

					// refresh parent (caller) wrap
					// build_autoload:false keeps the refresh local — avoids a full
					// server round-trip; only the children list in the caller tree
					// node needs to be re-painted.
					if (caller) {
						caller.refresh({
							build_autoload : false, // Local only update
							render_level   : 'full',
							destroy        : false
						})
					}

					// close modal
					modal.close()
				}
				button_delete.addEventListener('click', fn_click_unlink_and_delete)

			// delete diffusion records checkbox
			// When checked (default), delete_term will also remove any published
			// copies of this node from the diffusion (MariaDB/RDF) targets.
			// Setting self.delete_diffusion_records here ensures the flag is visible
			// to ts_object.prototype.delete_term even if the user never interacts
			// with the checkbox.
			const delete_diffusion_records_label = ui.create_dom_element({
				element_type	: 'label',
				class_name		: 'block_label unselectable',
				inner_html		: get_label.delete_diffusion_records || 'Delete diffusion records',
				parent			: footer
			})
			const delete_diffusion_records_checkbox = ui.create_dom_element({
				element_type	: 'input',
				type			: 'checkbox'
			})
			// default value is true
			delete_diffusion_records_checkbox.checked	= true
			self.delete_diffusion_records				= true
			// change event
			delete_diffusion_records_checkbox.addEventListener('change', (e) => {
				self.delete_diffusion_records = delete_diffusion_records_checkbox.checked
			})
			// append node
			delete_diffusion_records_label.prepend(delete_diffusion_records_checkbox)
			delete_diffusion_records_label.style = 'float:left'

		// focus button
		// Keyboard accessibility: once the button enters the viewport, move focus
		// to it so pressing Enter immediately triggers the delete flow.
		// dd_request_idle_callback defers the focus call until the browser is idle,
		// preventing a layout-triggered focus race during modal open animation.
			// Set the default button to be fired when the modal is active
			// when the user press the Enter key in the keyboard
			// the unlink option will be fired
			const focus_the_button = function() {
				// set the focus to the button_unlink
				dd_request_idle_callback(
					() => {
						button_delete.focus()
						button_delete.classList.add('focus')
					}
				)
				button_delete.addEventListener('keyup', (e)=>{
					e.preventDefault()
				})
			}
			// when the modal will be ready in DOM fire the function to attack the event
			when_in_viewport(button_delete, focus_the_button)
	}//end if (has_descriptor_children)

	// modal
	// Width is fixed at 50rem via the callback; the 'normal' size preset provides
	// a sensible default for screens that cannot fit 50rem.
		const modal = ui.attach_to_modal({
			header		: header,
			body		: body,
			footer		: footer,
			size		: 'normal', // string size small|big|normal
			callback	: (dd_modal) => {
				dd_modal.modal_content.style.width = '50rem'
			}
		})

	// self.delete(link_delete)

	return true
}//end render_delete_record_dialog



// @license-end
