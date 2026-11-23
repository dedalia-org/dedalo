/**
 * A `DOMParser` for Bun built on parse5 — the DECLARED devDependency (package.json; the
 * same spec parser test/helpers/html_oracle.ts drives) — exposing exactly the DOM surface
 * the tool_lang browser pipeline reads (tools/tool_lang/js/markdown_utils.js:
 * html_to_markdown, marks_in_text_nodes):
 *
 *   parseFromString(html).body, createTreeWalker(root, SHOW_TEXT).nextNode()
 *   node.nodeType / tagName / attributes / getAttribute / childNodes / textContent / outerHTML /
 *   cloneNode(false).outerHTML / parentElement / previousSibling / nextSibling
 *
 * Both halves are the HTML standard's: parse5 is a spec tree builder and its serialiser is
 * the spec's fragment serialisation algorithm — the one a browser's `outerHTML` runs. It is
 * still a stand-in for the browser: the real-browser twin of the pipeline is the client
 * suite `test_tool_lang_browser_translation`.
 *
 * `browserSerialize` is the comparison side: the HTML as a browser would hand it back
 * (`body.innerHTML` after parsing) — attribute quoting, character references and implied
 * tags (`<tbody>`) normalised, nothing else.
 */

import { type DefaultTreeAdapterTypes, parse, serialize, serializeOuter } from 'parse5';

type P5Node = DefaultTreeAdapterTypes.ChildNode | DefaultTreeAdapterTypes.ParentNode;
type P5Element = DefaultTreeAdapterTypes.Element;

/** A parse5 node's children — a <template>'s live in its content fragment. */
function childrenOf(node: P5Node): P5Node[] {
	if ('tagName' in node && node.tagName === 'template') {
		return (node as DefaultTreeAdapterTypes.Template).content.childNodes as P5Node[];
	}
	return 'childNodes' in node ? (node.childNodes as P5Node[]) : [];
}

/** The text of a node and its descendants, in document order. */
function textOf(node: P5Node): string {
	if (node.nodeName === '#text') return (node as DefaultTreeAdapterTypes.TextNode).value;
	if (node.nodeName === '#comment') return '';
	return childrenOf(node).map(textOf).join('');
}

/** The parse5 `<body>` of a parsed document. */
function bodyOf(html: string): P5Element {
	const document = parse(html);
	const root = document.childNodes.find((node) => node.nodeName === 'html') as P5Element;
	return root.childNodes.find((node) => node.nodeName === 'body') as P5Element;
}

const wrappers = new WeakMap<object, Record<string, unknown>>();

/** The DOM-shaped view of a parse5 node (one wrapper per node, so identity holds). */
function wrap(node: P5Node | undefined | null): Record<string, unknown> | null {
	if (!node) return null;
	const known = wrappers.get(node);
	if (known) return known;

	const sibling = (offset: number) => () => {
		const parent = (node as { parentNode?: P5Node | null }).parentNode;
		if (!parent) return null;
		const siblings = childrenOf(parent);
		return wrap(siblings[siblings.indexOf(node) + offset]);
	};
	const view: Record<string, unknown> = {};
	Object.defineProperties(view, {
		previousSibling: { get: sibling(-1) },
		nextSibling: { get: sibling(1) },
		parentElement: {
			get: () => {
				const parent = (node as { parentNode?: P5Node | null }).parentNode;
				return parent && 'tagName' in parent ? wrap(parent) : null;
			},
		},
		childNodes: { get: () => childrenOf(node).map(wrap) },
	});

	if (node.nodeName === '#text') {
		Object.defineProperties(view, {
			nodeType: { value: 3 },
			textContent: { get: () => (node as DefaultTreeAdapterTypes.TextNode).value },
		});
	} else if (node.nodeName === '#comment') {
		Object.defineProperties(view, {
			nodeType: { value: 8 },
			textContent: { get: () => (node as DefaultTreeAdapterTypes.CommentNode).data },
		});
	} else if ('tagName' in node) {
		const element = node as P5Element;
		Object.defineProperties(view, {
			nodeType: { value: 1 },
			tagName: { value: element.tagName.toUpperCase() },
			attributes: { get: () => element.attrs },
			getAttribute: {
				value: (name: string) =>
					element.attrs.find((attribute) => attribute.name === name)?.value ?? null,
			},
			textContent: { get: () => textOf(element) },
			outerHTML: { get: () => serializeOuter(element) },
			cloneNode: {
				value: (deep: boolean) => ({
					outerHTML: serializeOuter({
						...element,
						childNodes: deep ? element.childNodes : [],
					} as P5Element),
				}),
			},
		});
	} else {
		Object.defineProperty(view, 'nodeType', { value: 9 });
	}

	wrappers.set(node, view);
	return view;
}

/** The DOMParser stand-in (text/html only — the one type the pipeline parses). */
export class Parse5DomParser {
	parseFromString(html: string, type: string) {
		if (type !== 'text/html')
			throw new Error(`Parse5DomParser: only text/html is supported (got ${type})`);
		const body = bodyOf(html);
		return {
			body: wrap(body),
			// SHOW_TEXT only: every text node under the root, in document order
			createTreeWalker(_root: unknown, whatToShow: number) {
				if (whatToShow !== 4)
					throw new Error('Parse5DomParser: only NodeFilter.SHOW_TEXT is supported');
				const texts: DefaultTreeAdapterTypes.TextNode[] = [];
				const visit = (node: P5Node) => {
					if (node.nodeName === '#text') texts.push(node as DefaultTreeAdapterTypes.TextNode);
					for (const child of childrenOf(node)) visit(child);
				};
				visit(body);
				let index = 0;
				return {
					nextNode: () => {
						const text = texts[index++];
						return text ? { textContent: text.value } : null;
					},
				};
			},
		};
	}
}

/** Install the stand-in as `globalThis.DOMParser`; returns the restore function. */
export function installParse5DomParser(): () => void {
	const globals = globalThis as Record<string, unknown>;
	const previous = globals.DOMParser;
	globals.DOMParser = Parse5DomParser;
	return () => {
		globals.DOMParser = previous;
	};
}

/**
 * The HTML as a browser hands it back after parsing it (`body.innerHTML`): the spec
 * serialiser's normalisation — attribute quoting, character references, implied tags.
 */
export function browserSerialize(html: string): string {
	return serialize(bodyOf(html));
}

/** Is a node skipped when looking for a whitespace-only text node's neighbours? */
const isSkippedNeighbour = (node: P5Node) =>
	node.nodeName === '#comment' ||
	(node.nodeName === '#text' &&
		!/[^ \t\n\r\f]/.test((node as DefaultTreeAdapterTypes.TextNode).value));

/**
 * The nearest sibling of a node in one direction that is not a comment nor whitespace-only
 * text: its tag name, '#text' for text with words, null when there is none.
 */
function neighbourName(siblings: P5Node[], index: number, step: 1 | -1): string | null {
	for (let i = index + step; i >= 0 && i < siblings.length; i += step) {
		const sibling = siblings[i] as P5Node;
		if (!isSkippedNeighbour(sibling)) return sibling.nodeName;
	}
	return null;
}

/**
 * What `mapWordTextNodes` does under an element: 'subtree' leaves everything inside alone;
 * 'keep' leaves its text alone unless a descendant says 'transform'; undefined inherits.
 */
export type TextRule = 'subtree' | 'keep' | 'transform' | undefined;

/**
 * Apply `transform` to every text node of the parsed HTML that is not under a 'subtree'
 * element nor (nearest decides) a 'keep' one — `rule(tagName, attribute)` says which — and
 * either carries a character other than ASCII whitespace (U+00A0 counts as a character) or
 * is whitespace-only and `isWordSpace(previous, next, parent)` says it is a word space (the
 * arguments: its nearest non-comment, non-whitespace neighbours' names — a tag, '#text', or
 * null — and its parent's tag) and no ancestor element is WORDLESS (its text all whitespace,
 * U+00A0 included: such an element travels whole); serialise the result as
 * `browserSerialize` does.
 */
export function mapWordTextNodes(
	html: string,
	transform: (text: string) => string,
	rule: (tagName: string, attribute: (name: string) => string | null) => TextRule = () => undefined,
	isWordSpace: (previous: string | null, next: string | null, parent: string) => boolean = () =>
		false,
): string {
	const body = bodyOf(html);
	const visit = (node: P5Node, insideWordless: boolean, keeping: boolean) => {
		let keep = keeping;
		if ('tagName' in node && node !== body) {
			const element = node as P5Element;
			const decided = rule(
				element.tagName,
				(name) => element.attrs.find((attribute) => attribute.name === name)?.value ?? null,
			);
			if (decided === 'subtree') return;
			if (decided === 'keep') keep = true;
			if (decided === 'transform') keep = false;
		}
		const wordless = insideWordless || (node !== body && !/\S/.test(textOf(node)));
		const children = childrenOf(node);
		children.forEach((child, index) => {
			if (child.nodeName !== '#text') {
				visit(child, wordless, keep);
				return;
			}
			if (keep) return;
			const text = child as DefaultTreeAdapterTypes.TextNode;
			const words = /[^ \t\n\r\f]/.test(text.value);
			const parent = 'tagName' in node ? node.tagName : '';
			if (
				words ||
				(!wordless &&
					isWordSpace(
						neighbourName(children, index, -1),
						neighbourName(children, index, 1),
						parent,
					))
			) {
				text.value = transform(text.value);
			}
		});
	};
	visit(body, false, false);
	return serialize(body);
}

/** The visible text of an HTML fragment as a browser reads it (`body.textContent`). */
export function visibleText(html: string): string {
	return textOf(bodyOf(html));
}

/** Every element named in `names`, with its text (`textContent`), in document order. */
export function elementTexts(
	html: string,
	names: ReadonlySet<string>,
): { name: string; text: string }[] {
	const found: { name: string; text: string }[] = [];
	const visit = (node: P5Node) => {
		for (const child of childrenOf(node)) {
			if ('tagName' in child && names.has(child.tagName))
				found.push({ name: child.tagName, text: textOf(child) });
			visit(child);
		}
	};
	visit(bodyOf(html));
	return found;
}

/** Every element's tag name in document order (the parsed tree, not the string). */
export function elementNames(html: string): string[] {
	const names: string[] = [];
	const visit = (node: P5Node) => {
		for (const child of childrenOf(node)) {
			if ('tagName' in child) names.push(child.tagName);
			visit(child);
		}
	};
	visit(bodyOf(html));
	return names;
}
