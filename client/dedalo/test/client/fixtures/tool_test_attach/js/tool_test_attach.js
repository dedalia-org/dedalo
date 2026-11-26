// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/

// Its sheet, css/tool_test_attach.css, is injected by build() via load_style(tool_css_url);
// a missing sheet rejects the build, so the fixture ships one (css_corpus_tripwire).
import { common } from '../../../../../core/common/js/common.js';
import { tool_common, wire_tool } from '../../../../../core/tools_common/js/tool_common.js';

/**
 * TOOL_TEST_ATTACH — the client suite's scratch `open_as:'attach'` tool.
 *
 * Lives under test/client/fixtures/, NEVER under tools/: it is not a registered
 * tool, has no register.json, no dd1324 record and no server half, so no
 * installation ever lists it. test_tool_open_as_attach.js reaches it through the
 * engine's own additional-tools-root door — it maps this directory in
 * DEDALO_TOOLS_URLS for the duration of the suite — so get_instance imports and
 * constructs it, and tool_css_url loads its stylesheet, exactly as they do for a
 * tool in a DEDALO_ADDITIONAL_TOOLS root.
 *
 * Every lifecycle call is recorded in `attach_fixture.log`; the suite steers the
 * failure modes through the same object (a slow attach, a throwing or falsy
 * attach, a missing detach).
 */
export const attach_fixture = {
	log: [],
	attach_delay_ms: 0,
	attach_throws: false,
	attach_result: true,
	omit_detach: false,
	reset() {
		this.log = [];
		this.attach_delay_ms = 0;
		this.attach_throws = false;
		this.attach_result = true;
		this.omit_detach = false;
	},
	count(op) {
		return this.log.filter((entry) => entry.op === op).length;
	},
	ops() {
		return this.log.map((entry) => entry.op);
	},
};

const SURFACE_CLASS = 'tool_test_attach_surface';

export const tool_test_attach = function () {
	this.id = null;
	this.model = null;
	this.caller = null;
	this.status = null;
	this.surface = null;
	// the half-contract case: an attach tool that cannot remove what it added
	if (attach_fixture.omit_detach === true) {
		this.detach = null;
	}
};

// standard wiring (render, destroy, refresh, tool_request)
wire_tool(tool_test_attach);

tool_test_attach.prototype.init = async function (options) {
	attach_fixture.log.push({ op: 'init', id: this.id });
	return tool_common.prototype.init.call(this, options);
};

// build: the real tool_common.build (status, tool CSS, error labels) without the
// server round trips a registered tool makes — this tool has no ddo_map to load
// and no context to fetch. The autoload flag view_attach passed is recorded.
tool_test_attach.prototype.build = async function (autoload = false) {
	attach_fixture.log.push({ op: 'build', id: this.id, autoload });
	return tool_common.prototype.build.call(this, false, { load_ddo_map: async () => true });
};

tool_test_attach.prototype.render = async function () {
	attach_fixture.log.push({ op: 'render', id: this.id });
	return null;
};

tool_test_attach.prototype.attach = async function () {
	attach_fixture.log.push({ op: 'attach', id: this.id });
	if (attach_fixture.attach_delay_ms > 0) {
		await new Promise((resolve) => setTimeout(resolve, attach_fixture.attach_delay_ms));
	}
	if (attach_fixture.attach_throws === true) {
		throw new Error('tool_test_attach: attach failed on purpose');
	}
	if (attach_fixture.attach_result !== true) {
		return attach_fixture.attach_result;
	}
	const surface = document.createElement('div');
	surface.className = SURFACE_CLASS;
	surface.dataset.toolInstance = this.id;
	this.caller.node.appendChild(surface);
	this.surface = surface;
	attach_fixture.log.push({ op: 'attached', id: this.id, node: this.caller.node });
	return true;
};

tool_test_attach.prototype.detach = async function () {
	attach_fixture.log.push({ op: 'detach', id: this.id });
	// tolerates an already-gone surface (the caller's node may have been replaced)
	this.surface?.remove();
	this.surface = null;
	return true;
};

tool_test_attach.prototype.destroy = async function (...args) {
	attach_fixture.log.push({ op: 'destroy', id: this.id });
	return common.prototype.destroy.apply(this, args);
};
