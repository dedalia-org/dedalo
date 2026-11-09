// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label, page_globals, SHOW_DEBUG, DEDALO_CORE_URL*/
/*eslint no-undef: "error"*/



/**
* COMPONENT_EMAIL
* Dédalo client-side component for storing, validating, and sending e-mail addresses.
*
* Responsibilities:
* - Holds one or more e-mail address strings per record (multi-value via entries array).
* - Validates each address against a standard RFC-safe regex before saving.
* - Provides `send_email` (single-address mailto:) and `get_ar_emails` (bulk BCC mailto:
*   spanning all records matched by the current search, chunked for OS character limits).
* - Delegates rendering to render_edit / render_list / render_search sub-modules.
* - Inherits the full component lifecycle (init → build → render → save → destroy) from
*   component_common and common.
*
* Data shape (`this.data.entries`): Array of plain objects
*   { id: number|null, value: string, lang: string }
* Each entry holds one e-mail address; multi-value rows (comma-separated addresses in one
* entry) are NOT the primary shape — use multiple entries instead.
*
* @see component_common  Generic lifecycle, save, change_value, and mode-switch logic.
* @see render_edit_component_email  Edit-mode view dispatch (default / line / mini / print).
* @see render_list_component_email  List/TM view dispatch.
* @see render_search_component_email  Search-filter view.
*/

// imports
	import {common} from '../../common/js/common.js'
	import {request_complete} from '../../common/js/sqo_limit.js'
	import {component_common} from '../../component_common/js/component_common.js'
	import {render_edit_component_email} from '../../component_email/js/render_edit_component_email.js'
	import {render_list_component_email} from '../../component_email/js/render_list_component_email.js'
	import {render_search_component_email} from '../../component_email/js/render_search_component_email.js'



/**
* COMPONENT_EMAIL
* Constructor. Declares all instance properties used throughout the lifecycle.
* All fields are initialised to null; component_common.init() populates them
* from the options object passed at mount time.
*/
export const component_email = function(){

	this.id				= null

	// element properties declare
	this.model			= null
	this.tipo			= null
	this.section_tipo	= null
	this.section_id		= null
	this.mode			= null
	this.lang			= null

	this.section_lang	= null
	this.context		= null
	this.data			= null
	this.parent			= null
	this.node			= null

	this.tools			= null

	// ui
	this.minimum_width_px = 100 // integer pixels
}//end component_email



/**
* COMMON FUNCTIONS
* Extend component_email with shared prototype methods from component_common and common.
* No own implementations for these methods — all logic lives in the shared prototypes.
*/
// prototypes assign
	// lifecycle
	component_email.prototype.init				= component_common.prototype.init
	component_email.prototype.build				= component_common.prototype.build
	component_email.prototype.render			= common.prototype.render
	component_email.prototype.refresh			= common.prototype.refresh
	component_email.prototype.destroy			= common.prototype.destroy

	// change data
	component_email.prototype.save				= component_common.prototype.save
	component_email.prototype.update_data_value	= component_common.prototype.update_data_value
	component_email.prototype.update_datum		= component_common.prototype.update_datum
	component_email.prototype.change_value		= component_common.prototype.change_value
	component_email.prototype.set_changed_data	= component_common.prototype.set_changed_data
	component_email.prototype.build_rqo			= common.prototype.build_rqo

	// render
	component_email.prototype.list				= render_list_component_email.prototype.list
	component_email.prototype.edit				= render_edit_component_email.prototype.edit
	component_email.prototype.search			= render_search_component_email.prototype.search

	component_email.prototype.change_mode		= component_common.prototype.change_mode



/**
* VERIFY_EMAIL
* Validates one or more e-mail address strings.
* Accepts either a single string or an array of strings. Returns true only when
* ALL addresses pass the regex. An empty string (or empty array) is accepted as
* valid so that a user can clear the field without a validation error.
*
* Regex notes (UIUX-04):
* - TLD quantifier is {2,} — open-ended to support long TLDs like .museum / .travel.
*   (A previous version used {2,4}, which rejected those valid TLDs.)
* - Case-insensitive flag `/i` normalises mixed-case user input.
* - ALL entries must pass via Array.every(); an earlier forEach implementation only
*   checked the LAST address, allowing invalid leading entries to slip through.
*
* @param {string|Array} email_value - A single address string or an array of address strings.
* @returns {boolean} true when all supplied addresses are syntactically valid (or the value
*   is empty), false when at least one address fails the regex.
*/
component_email.prototype.verify_email = function(email_value) {

	// When we want delete email data, allow empty value
	if (email_value.length<1) {
		return true;
	}

	// UIUX-04: TLD quantifier {2,} (was {2,4}, which rejected valid long TLDs like
	// .museum / .travel).
	const emailRegEx	= /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

	const ar_email = (!Array.isArray(email_value))
		? [email_value]
		: email_value

	// UIUX-04: ALL addresses must be valid. The previous forEach reassigned
	// valid_email each iteration, so the result reflected only the LAST address
	// (e.g. ['bad@','good@x.com'] wrongly validated as true).
	const valid_email = ar_email.every(function(email) {
		return typeof email === 'string' && email.search(emailRegEx) !== -1
	})

  	// debug
  		if(SHOW_DEBUG===true) {
  			if (valid_email!==true) {
  				console.warn("Invalid email rejected:",email_value);
  			}
  		}


	return valid_email;
}//end verify_email



/**
* SEND_EMAIL
* Opens the user's default mail client for a single address via a `mailto:` navigation.
* Navigation is triggered by assigning to `window.location.href`; no new tab is opened.
* Returns false immediately when `value` is empty or falsy (no-op).
*
* (!) This method is intended for single-record, single-address use. For bulk BCC across
* all records currently in the search result use `get_ar_emails` instead.
*
* @param {string} value - The e-mail address to open in the mail client.
* @returns {boolean} true when the mailto: navigation was triggered, false when skipped.
*/
component_email.prototype.send_email = function(value) {

	const email = value || []
	if(email.length<1){
		return false
	}

	window.location.href = 'mailto:' + email


	return true
}//end send_email



/**
* GET_AR_EMAILS
* Fetches ALL e-mail addresses from every record that matches the parent section's
* current search query, then returns them as an array of `;`-separated strings
* chunked to respect OS mailto: character limits.
*
* Chunking rationale: Windows limits `mailto:` URIs to ~2 000 characters; the inner
* `get_ar_emails` helper recursively splits the full address string at `;` boundaries
* so that each chunk stays within `max_characters`. Non-Windows platforms receive the
* full string as a single-element array (no chunking needed).
*
* Walk-up contract:
*   self.caller          → section_record (the row that contains this component)
*   self.caller.caller   → section or portal (the builder that holds the rqo)
* If the grandparent is not a section or portal the method returns false immediately.
*
* The server request is a clone of the builder's rqo with:
*   - `show.ddo_map` narrowed to this component only (minimises payload).
*   - `sqo.limit` set to 0 (retrieve all matching records, no pagination).
*
* (!) The `is_windows` detection uses `navigator.platform` which is deprecated in modern
* browsers. The variable is named `is_windows` but the regex `/(Mac)/i` matches Mac
* (not Windows) — meaning Mac platforms receive the chunking path instead of Windows.
* This is a pre-existing inconsistency; do not change it here.
*
* (!) The guard condition `builder?.model !== 'section' || builder?.model !== 'component_portal'`
* is a logical tautology (always true for any single string) that causes the method to
* return false for every caller. This is a pre-existing bug; flagged for review.
*
* @returns {Promise<Array|boolean>} Resolves to an Array of `;`-separated email chunk
*   strings ready for `mailto:?bcc=` navigation, or false when no addresses were found
*   or the caller hierarchy is unexpected.
*/
component_email.prototype.get_ar_emails = async function() {

	const self = this

	// builder should be section or portal, the self.caller normally will be a section_record, and his caller should be the builder
	const builder = self.caller?.caller
	// check if the builder is a section or portal. Sometimes it could be a tool, or widget,...
	if(!builder || (builder?.model !== 'section' && builder?.model !== 'component_portal')){
		return false
	}
	// get the rqo of the builder, it will use to redo the search but only for the email
	const rqo = structuredClone(builder.rqo)

	// set the show with email component_data: ONE item per searched record
		rqo.show = {}
		rqo.show.ddo_map =[{
			tipo			: self.tipo,
			parent			: 'self',
			section_tipo	: self.section_tipo
		}]

	// load data. A COMPLETENESS read (every searched record's emails): walked
	// page by page at the server's client ceiling through request_complete
	// (common/js/sqo_limit.js) — never one request with `limit: 0`, which the
	// server read as the same ceiling and truncated in silence (audit P2-31 /
	// CLI-29). The builder's total, when it has one, bounds the walk.
		const search_datum = await request_complete(rqo, {
			total		: Number.isFinite(Number(builder.total)) ? Number(builder.total) : null,
			count_rows	: (datum) => datum.data.filter(el => el.tipo === self.tipo).length
		})
		if (!search_datum) {
			return false
		}

	// get the result of the datum
		const data = search_datum.data.filter(el => el.tipo === self.tipo)

	// check if the data is empty
		const len = data.length

		if(len <= 0){
			return false
		}
	// set some vars
		const separator = ';';
		const emails = []
		const is_windows = /Win/i.test(navigator.platform)
		const max_characters = 1900 // Windows caps mailto: URIs at ~2000 chars
		// check the data and remove the empty values
		for (let i = len - 1; i >= 0; i--) {
			// entries are { id, value, lang } objects: keep the non-empty address strings
			const current_data = (data[i].entries ?? [])
				.map(el => el?.value?.trim())
				.filter(Boolean)
			if(current_data.length<=0) {
				continue
			}
			// join the emails with the separator to create a string with all values
			// every value can handle more than 1 email, here join only the values of 1 record and add to emails array
			const current_emails = current_data.join(separator)
			emails.push(current_emails)
		}
		// join all emails with the separator to create a full string with all emails
		const full_emails = emails.join(separator)

		// truncate the full email string into arrays strings with the limit of characters
		function get_ar_emails(emails) {
			const ar_emails = []
			// id the length is longer than the max_character proceed else add the string to the array.
			if(emails.length > max_characters){
				const truncate_position = emails.indexOf(separator, max_characters);
				// final strings could be a bit longer the max_characters and indexOf can not find the separator, in these cases the string will be correct.
				if(truncate_position === -1){
					ar_emails.push(emails)
				}else{
					// create the part_one and the part_two of the emails breaking by the separator more close to the max_characters
					// the part_one will be correct, but the part_two could be longer than the max_characters and need to be processed again.
					const part_one = emails.slice(0, truncate_position);
					const part_two = emails.slice(truncate_position + 1);
					ar_emails.push(part_one)
					// check if the part_two is longer to be processed, else the part two will be the final string
					if(part_two.length > max_characters){
						// recursion
						const parts = get_ar_emails(part_two)
						ar_emails.push(...parts)
					}else{
						ar_emails.push(part_two)
					}//end if(part_two.length > max_characters)
				}//end if(truncate_position === -1)

			}else{
				ar_emails.push(emails)
			}//end if(emails.length > max_characters)
			return ar_emails
		}//end get_ar_emails

		// build the final array checking if the client SO is windows (it has a limitation of characters), else pass the full string.
		const ar_emails = is_windows
			? get_ar_emails(full_emails)
			: [full_emails]


	return ar_emails
}//end get_ar_emails



// @license-end
