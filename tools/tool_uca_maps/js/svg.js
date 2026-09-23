// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* SVG
*
* The tool draws its own vector chrome — the compass rose (`scale_bar.js`),
* the uncertainty band strip (`render_object_console.js`) and the eye
* (`icons.js`). All three were built as HTML STRINGS
* handed to `inner_html` / `innerHTML`, i.e. an HTML-parsing sink. A node
* built through a factory is inert — there is no parse to subvert — so the
* sink stops existing instead of being escaped or excused.
*
* WHAT THAT IS AND IS NOT WORTH. `render_escape_tripwire` only counts a sink
* whose value it cannot prove static, so two of those three were already
* green; converting them buys the SHAPE, not a gate. The shape is the point:
* the classifier is textual, so a later edit that interpolates one value into
* an existing markup string turns a green site red with nothing to warn the
* author. There is no node to interpolate into.
*
* ONE SITE IS DELIBERATELY LEFT AS MARKUP: `legend.js` DEFAULT_ELEMENT_ICON.
* It is not a DOM sink at all — the string is base64'd into a `data:` URI for
* an `<img src>`, a document with no scripting and no access to this one, so
* there is nothing here that would apply to it.
*
* Nothing below is a general-purpose DOM library. It is the smallest thing
* that makes an `<svg>` subtree read as data: a tag, its attributes, its
* children.
*
* @module svg
*/



/** SVG lives in its own namespace: `document.createElement('rect')` builds an
* unknown HTML element that renders nothing at all, silently. */
const SVG_NS = 'http://www.w3.org/2000/svg'



/**
* SVG_NODE
* Builds one SVG element and its subtree. Attribute values are SET, never
* interpolated into markup, so a number or a label reaches the DOM as data.
*
* @param {string} tag - 'svg', 'rect', 'circle', 'g', 'text', 'polygon'…
* @param {Object} [attributes] - attribute name → value; null/undefined skipped
* @param {Array<Node|string>} [children] - nodes, or strings as text content
* @returns {SVGElement}
*/
export const svg_node = function(tag, attributes, children) {

	const node = document.createElementNS(SVG_NS, tag)

	if (attributes) {
		for (const name in attributes) {
			const value = attributes[name]
			if (value === null || value === undefined) {
				continue
			}
			node.setAttribute(name, String(value))
		}
	}

	if (children) {
		const len = children.length
		for (let i = 0; i < len; i++) {
			const child = children[i]
			node.appendChild(
				typeof child === 'string'
					? document.createTextNode(child)
					: child
			)
		}
	}

	return node
}//end svg_node



// @license-end
