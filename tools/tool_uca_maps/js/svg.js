// @license magnet:?xt=urn:btih:0b31508aeb0634b347b8270c7bee4d411b5d4109&dn=agpl-3.0.txt AGPL-3.0
/*eslint no-undef: "error"*/



/**
* SVG
* The tool's vector chrome (compass, uncertainty strip, eye) is built as nodes, not
* HTML strings: a factory-built node is inert, so there is no sink to escape. Attributes
* are SET, never interpolated, so a later edit cannot turn a static string unsafe.
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
