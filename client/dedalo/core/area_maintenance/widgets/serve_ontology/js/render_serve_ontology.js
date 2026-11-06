// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*global get_label */
/*eslint no-undef: "error"*/

// imports
import { ui } from '../../../../common/js/ui.js';

/**
 * RENDER_SERVE_ONTOLOGY
 * View layer of the serve_ontology widget: can other installations pull their
 * ontology from THIS one? Three ../private/.env keys decide it, so the panel shows
 * one live checklist row per key, the literal .env lines to add, and the endpoint
 * clients register in their own ONTOLOGY_SERVERS.
 *
 * Widget value shape (serve_ontology.ts getValue):
 *   { enabled, has_server_code, cors_enabled, url }
 * The access code itself never rides the wire — only whether one is configured.
 *
 * SEC-031: `url` is a server string and reaches the DOM as a TEXT NODE only.
 */
export const render_serve_ontology = function () {
	return true;
}; //end render_serve_ontology

/**
 * LIST
 * Entry point for both 'edit' and 'list' modes. `render_level` 'content' returns
 * the content_data node only (widget_common.load repaint path).
 * @param {Object} options
 * @returns {Promise<HTMLElement>}
 */
render_serve_ontology.prototype.list = async function (options) {
	const self = this;

	const render_level = options.render_level || 'full';

	// content_data
	const content_data = get_content_data_edit(self);
	if (render_level === 'content') {
		return content_data;
	}

	// wrapper
	const wrapper = ui.widget.build_wrapper_edit(self, {
		content_data: content_data,
	});
	wrapper.content_data = content_data;

	return wrapper;
}; //end list

/**
 * GET_CONTENT_DATA_EDIT
 * @param {Object} self - widget instance (self.value = the serving readout)
 * @returns {HTMLElement} content_data
 */
const get_content_data_edit = function (self) {
	const serving = self.value || {};
	const ready =
		serving.enabled === true && serving.has_server_code === true && serving.cors_enabled === true;

	const content_data = ui.create_dom_element({
		element_type: 'div',
		class_name: 'content_data serve_ontology_content',
	});

	// state line
	const state = ui.create_dom_element({
		element_type: 'div',
		class_name: 'serve_state',
		parent: content_data,
	});
	ui.create_dom_element({
		element_type: 'span',
		class_name: 'ttl',
		inner_html: get_label.serve_ontology_title || 'Serve this ontology to other installations',
		parent: state,
	});
	ui.create_dom_element({
		element_type: 'span',
		class_name: ready ? 'dd_badge pill_ok' : 'dd_badge pill_warning',
		inner_html: ready
			? get_label.serve_ontology_state_on || 'Enabled'
			: get_label.serve_ontology_state_off || 'Not configured',
		parent: state,
	});

	ui.create_dom_element({
		element_type: 'p',
		class_name: 'dd_note',
		inner_html:
			get_label.serve_ontology_body ||
			'To let other installations pull <i>from here</i> — they add this server to their own <code>ONTOLOGY_SERVERS</code> — configure <code>../private/.env</code> with at least these keys and restart the server.',
		parent: content_data,
	});

	// live checklist
	const checks = [
		{
			ok: serving.enabled === true,
			k: 'IS_AN_ONTOLOGY_SERVER',
			v: serving.enabled === true ? 'true' : get_label.serve_ontology_state_not_set || 'not set',
			d:
				get_label.serve_ontology_key_server_info ||
				'Opens the ontology JSON endpoint and adds the “Local files” source here.',
		},
		{
			ok: serving.has_server_code === true,
			k: 'ONTOLOGY_SERVERS',
			v:
				serving.has_server_code === true
					? get_label.serve_ontology_state_configured || 'configured'
					: get_label.serve_ontology_state_not_set || 'not set',
			d:
				get_label.serve_ontology_key_code_info ||
				'The access codes this server accepts: the code of every ONTOLOGY_SERVERS entry. Pick your own per client; each client stores its code in its own ONTOLOGY_SERVERS entry.',
		},
		{
			ok: serving.cors_enabled === true,
			k: 'DEDALO_CORS_ALLOWED_ORIGINS',
			v:
				serving.cors_enabled === true
					? get_label.serve_ontology_state_configured || 'configured'
					: get_label.serve_ontology_state_not_set || 'not set',
			d:
				get_label.serve_ontology_key_cors_info ||
				'Clients call this server from their browser, so their origin must be allowed. <code>["*"]</code> opens it to any origin; list the client origins instead when you know them.',
		},
	];
	const list = ui.create_dom_element({
		element_type: 'div',
		class_name: 'serving_checks',
		parent: content_data,
	});
	checks.forEach((check) => {
		const row = ui.create_dom_element({
			element_type: 'div',
			class_name: check.ok ? 'chk on' : 'chk off',
			parent: list,
		});
		ui.create_dom_element({
			element_type: 'span',
			class_name: 'mark',
			inner_html: check.ok ? '✓' : '•',
			parent: row,
		});
		const txt = ui.create_dom_element({ element_type: 'div', class_name: 'txt', parent: row });
		const head = ui.create_dom_element({ element_type: 'div', class_name: 'hd', parent: txt });
		ui.create_dom_element({ element_type: 'code', text_content: check.k, parent: head });
		ui.create_dom_element({
			element_type: 'span',
			class_name: 'val',
			text_content: check.v,
			parent: head,
		});
		ui.create_dom_element({
			element_type: 'div',
			class_name: 'desc',
			inner_html: check.d,
			parent: txt,
		});
	});

	// the literal .env block
	ui.create_dom_element({
		element_type: 'pre',
		class_name: 'env_sample',
		text_content: [
			'IS_AN_ONTOLOGY_SERVER=true',
			'ONTOLOGY_SERVERS=[{"name":"A client","url":"https://client.example.org/dedalo/core/api/v1/json/","code":"xx-myspecialcode-xxx"}]',
			'DEDALO_CORS_ALLOWED_ORIGINS=["*"]',
		].join('\n'),
		parent: content_data,
	});

	// the URL clients must register
	if (serving.url) {
		const url_row = ui.create_dom_element({
			element_type: 'div',
			class_name: 'serve_url',
			parent: content_data,
		});
		ui.create_dom_element({
			element_type: 'span',
			class_name: 'dd_k',
			inner_html: get_label.serve_ontology_endpoint_register || 'Endpoint clients register',
			parent: url_row,
		});
		ui.create_dom_element({
			element_type: 'code',
			text_content: String(serving.url),
			parent: url_row,
		});
	}

	return content_data;
}; //end get_content_data_edit

// @license-end
