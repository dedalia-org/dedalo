/**
 * Shared tool types (the runtime registry face). The ToolServerModule plugin
 * contract lives in ./module.ts; this file holds the data shapes the registry
 * reader and the section/component tool filter produce and consume.
 */

/**
 * The closed set of tool open modes (`properties.open_as` in register.json /
 * dd1335). Absent = 'modal'.
 *   - 'modal':  the tool renders in a modal over the page (default).
 *   - 'window': the tool renders in a separate browser window.
 *   - 'attach': the tool is built straight onto its live caller component (no
 *     modal/window); its client class implements attach()/detach(), render() is
 *     unused. Requires show_in_component: true and show_in_inspector: false.
 * Enforced at registration by validateRegister (./register.ts).
 */
export const TOOL_OPEN_AS_VALUES = ['modal', 'window', 'attach'] as const;
export type ToolOpenAs = (typeof TOOL_OPEN_AS_VALUES)[number];

/**
 * One toolbar-entry DDO (PHP tool_common::create_tool_simple_context). This is
 * the object the client toolbar renders and the object `open_tool` clones as a
 * tool's caller context.
 */
export interface ToolSimpleContext {
	typo: 'ddo';
	type: 'tool';
	section_tipo: string;
	mode: 'edit';
	model: string;
	/** Present only when the tool has view/open_as properties (dd_object drops null). */
	properties?: unknown;
	label: string;
	css: { url: string };
	name: string;
	icon: string;
	show_in_inspector: boolean;
	show_in_component: boolean;
}

/** The element an element-tools filter runs against (PHP common::get_tools $this). */
export interface ElementToolsTarget {
	/** The element's runtime model (e.g. 'section', 'component_input_text'). */
	model: string;
	tipo: string;
	/**
	 * The section the element LIVES in (PHP `$this->get_section_tipo()`): a
	 * section's own tipo, a component's owning section. REQUIRED (T2-O11-4):
	 * the dd15 rule and every tool's is_available hook read it — the old filter
	 * fabricated it from `tipo`, so a component context lied about its section.
	 */
	sectionTipo: string;
	/** The element's mode (PHP `$this->mode`), handed to is_available. REQUIRED. */
	mode: string;
	/** True for component_* models (enables the 'all_components' catch-all). */
	isComponent: boolean;
	/** The element's translatable flag (components: gates requirement_translatable). */
	translatable: boolean;
	/** Keys of the element's own properties.tool_config (in_properties match). */
	toolConfigKeys: string[];
}

/** Result of the element-tools filter, with the availability-ledgered tools. */
export interface ElementToolsResult {
	tools: ToolSimpleContext[];
	/** Tools omitted because their availability decision is ledgered. */
	ledgered: string[];
}
