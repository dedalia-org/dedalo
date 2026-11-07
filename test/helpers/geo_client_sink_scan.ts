/**
 * The CLIENT-SINK SCAN of the geolocation map definition — a structural check that
 * client code never feeds a legend or a source value to an HTML sink.
 *
 * The posture of `legend` and `sources` (src/core/geo/map_legend.ts, layer 3) is a
 * rule about client code: an icon only as the `src` of an `<img>`, every label,
 * title, name only as text. No server-side validator can enforce it, so a gate
 * reads the client. An earlier version of this gate was a regular expression on one
 * physical line (a sink token and a legend word on the same line); it missed
 *
 *   const html = `<img src="${symbol.icon}">`;   row.innerHTML = html          (two lines)
 *   ui.create_dom_element({ inner_html: legend.title })     (the project's own sink)
 *   marker.bindPopup(`<b>${symbol.label}</b>`)               (a Leaflet HTML option)
 *   L.divIcon({ html: `<img src="${symbol.icon}">` })        (another one)
 *
 * so this one is read from the PARSED source (@babel/parser, as the complexity
 * ratchet does), by STATEMENT, with a small taint pass:
 *
 *   unit      a simple statement (expression, declaration, return, throw), a class
 *             field, or the expression body of an arrow function. A nested function
 *             is judged as units of its own; the statement around it does not
 *             include it.
 *   sink      a property or member named innerHTML, outerHTML, insertAdjacentHTML,
 *             createContextualFragment, setHTMLUnsafe, parseFromString, srcdoc,
 *             inner_html (the project's create_dom_element option), html (jQuery's
 *             `.html(` and Leaflet's divIcon option), write/writeln on `document`,
 *             or a Leaflet call that takes HTML: bindPopup, bindTooltip,
 *             setContent, setPopupContent, divIcon. A member is a member however it
 *             is spelled: `a.b`, `a?.b`, `a['b']`, `a?.['b']` (a computed key counts
 *             when it is a string literal or a template without expressions). A call
 *             is a call however it is made: `f()`, `f?.()`, `new F()`, `f.call(t, …)`,
 *             `f.apply(t, [ … ])`, `f.bind(t, …)`, and through an ALIAS — a name
 *             declared or assigned from a sink member or a `.bind` of one
 *             (`const add = control.addOverlay.bind(control)`), or destructured from
 *             an object (`const { addOverlay } = control`).
 *   mention   a name in the unit that is a map-definition word — legend, source(s),
 *             symbol(s), icon(s), attribution, matched per word of the name, so
 *             `legend_node` and `mapSources` count — or a TAINTED name or member
 *             path: a variable assigned (declared, assigned, destructured — also
 *             `({ title: t } = legend)`) from something that mentions, a member path
 *             assigned from one (`o.label = legend.title` taints `o.label`), a class
 *             field initialised from one (`label = legend.title` taints
 *             `this.label`), a `for...of` variable over one, or a callback parameter
 *             of a call whose callee mentions (`legend.groups.forEach((group) => …)`).
 *             Taint is per FUNCTION (a name tainted in one function says nothing
 *             about the same name in another, which a file-wide set would — `e`,
 *             `layer`, `content` are names every map handler reuses) and flows into
 *             the closures inside it — EXCEPT a `this.<p>` path, which is FILE-WIDE:
 *             `this` is the instance every prototype method of the file shares, and a
 *             name bound to `this` (`const self = this`) is read as `this`. It runs to
 *             a fixed point.
 *
 *   A unit is FLAGGED when it holds a sink and a mention, or an HTML-looking string
 *   (`<tag`, `</`, `<!`, `<?`) and a mention.
 *
 *   ARGUMENT sinks are judged by position, not by the whole unit: Leaflet's layer
 *   control writes a layer's NAME as HTML (`addOverlay(layer, name)`,
 *   `addBaseLayer(layer, name)`, and the KEYS of the objects given to
 *   `L.control.layers(base, overlays)` / `new L.Control.Layers(base, overlays)`), its
 *   attribution control writes its text (`addAttribution(text)`, `setPrefix(text)`).
 *   The layer beside the name is not HTML, so only the written argument is read —
 *   flagged when IT mentions. Positions are those the SINK sees: `.call`/`.bind` shift
 *   them by the `this` argument, `.apply` reads them from its array, a `.bind` alias
 *   continues after the arguments it bound, a spread of an array literal is
 *   inlined, and any other spread AT OR BEFORE the written position is judged as if it
 *   were the written argument (it may land on it).
 *   For these alone, a written argument that is WHOLLY escaped is not a mention: an
 *   escaper call, or a concatenation / template / conditional made only of escaper
 *   calls and literals. `control.addOverlay(layer, escape_markup(entry.name))` is the
 *   sanctioned shape; `escape_markup(x).replaceAll(…)` and `escape_markup(a) + b` are
 *   not escaped. An ESCAPER is trusted by what it IS, never by its name: a binding
 *   imported from `render_escape.js` (common/js/utils: `& < > " '` all encoded) under
 *   the name `escape_html`, or a one-parameter function whose whole body returns a
 *   trusted escaper applied to that parameter (`String(p ?? '')` allowed) — and only
 *   when EVERY binding of that name in the file is such a one (a parameter, a local
 *   `const escape_markup = (v) => v`, a reassignment: the name is not trusted). Escaping
 *   never makes a GENERAL sink safe: `node.innerHTML = escape_markup(legend.title)` is
 *   flagged (an escaped legend is still a legend written as markup; text goes to text).
 *   For the layers control, an object literal is judged by its keys (a computed key, a
 *   spread); any other argument by whether it mentions.
 *
 * What is NOT flagged, on purpose: handing `attribution` to Leaflet's
 * `attribution` option. That control renders HTML, so it is a sink — the ONE
 * sanctioned one — and what makes it safe is not this scan but the server: the
 * attribution is plain text without `<` or `>` at save AND when served
 * (map_source.ts, `servedMapSources`). `src`, `textContent` and text nodes are the
 * sanctioned destinations for everything else.
 *
 * RESIDUAL LIMITS (what this scan does not follow — stated, not hidden):
 *   - a computed key that is not a literal (`control[name](…)`, `base[source.name] =
 *     layer` added to a layers map later);
 *   - an alias that leaves its function (passed as an argument, returned, stored on a
 *     property), or a sink reached through `Reflect.apply`, `Function.prototype.call.call`,
 *     `eval`, a string-built name;
 *   - a member path stored through an alias of its object (`const a = o; a.x = …;`
 *     then `o.x`), through a computed key, or on a non-`this` object in another
 *     function; a value that leaves through a return value or a promise;
 *   - an escaper import is trusted by its module's file name (`render_escape.js`); the
 *     module's own behaviour is the render_escape tripwire's and this gate's evaluation
 *     of the client's `escape_markup`, not this scan's.
 * This is a HEURISTIC. It holds the client to the rule statement by statement; it
 * does not prove the rule, which is why the server layers never lean on it.
 */

import { parse } from '@babel/parser';

type Node = {
	type: string;
	start?: number;
	end?: number;
	loc?: { start: { line: number } };
} & Record<string, unknown>;

const SINK_NAMES: ReadonlySet<string> = new Set([
	'innerHTML',
	'outerHTML',
	'insertAdjacentHTML',
	'createContextualFragment',
	'setHTMLUnsafe',
	'parseFromString',
	'srcdoc',
	'inner_html',
	'html',
	'bindPopup',
	'bindTooltip',
	'setContent',
	'setPopupContent',
	'divIcon',
]);

/** Leaflet calls that write ONE argument as HTML, by its position (header: ARGUMENT sinks). */
const ARGUMENT_SINKS: ReadonlyMap<string, number> = new Map([
	['addOverlay', 1],
	['addBaseLayer', 1],
	['addAttribution', 0],
	['setPrefix', 0],
]);

/** The layers control: positions 0 and 1 are objects whose KEYS are written as HTML. */
const LAYERS = 'layers-control';

/** The canonical escaper, as `render_escape.js` exports it (header: an ESCAPER is trusted by what it IS). */
const CANONICAL_ESCAPER = 'escape_html';
const ESCAPER_MODULE = /(^|\/)render_escape\.js$/;

const MAP_WORDS: ReadonlySet<string> = new Set([
	'legend',
	'legends',
	'source',
	'sources',
	'symbol',
	'symbols',
	'icon',
	'icons',
	'attribution',
]);

const SIMPLE_STATEMENTS: ReadonlySet<string> = new Set([
	'ExpressionStatement',
	'VariableDeclaration',
	'ReturnStatement',
	'ThrowStatement',
	'ClassProperty',
	'ClassPrivateProperty',
]);

const FUNCTIONS: ReadonlySet<string> = new Set([
	'FunctionDeclaration',
	'FunctionExpression',
	'ArrowFunctionExpression',
	'ObjectMethod',
	'ClassMethod',
	'ClassPrivateMethod',
]);

/** A member, plain or optional (`a.b`, `a?.b`). */
const MEMBERS: ReadonlySet<string> = new Set(['MemberExpression', 'OptionalMemberExpression']);

/** A call, plain, optional or constructed (`f()`, `f?.()`, `new F()`). */
const CALLS: ReadonlySet<string> = new Set([
	'CallExpression',
	'OptionalCallExpression',
	'NewExpression',
]);

/** The Function.prototype forms that call their object (header: a call is a call however it is made). */
const INDIRECT_CALLS: ReadonlySet<string> = new Set(['call', 'apply', 'bind']);

const SKIPPED_KEYS: ReadonlySet<string> = new Set([
	'loc',
	'start',
	'end',
	'extra',
	'leadingComments',
	'trailingComments',
	'innerComments',
	'comments',
	'errors',
	'tokens',
]);

const MARKUP = /<[A-Za-z/!?]/;

function isNode(value: unknown): value is Node {
	return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

/** The child nodes of `node`, in source order of their keys. */
function childrenOf(node: Node): Node[] {
	const out: Node[] = [];
	for (const [key, value] of Object.entries(node)) {
		if (SKIPPED_KEYS.has(key)) continue;
		if (Array.isArray(value)) out.push(...value.filter(isNode));
		else if (isNode(value)) out.push(value);
	}
	return out;
}

/** Every node of `root`'s subtree, NOT descending into nested functions, in source order. */
function ownNodes(root: Node): Node[] {
	const out: Node[] = [];
	const visit = (current: Node): void => {
		if (FUNCTIONS.has(current.type) && current !== root) return;
		out.push(current);
		for (const child of childrenOf(current)) visit(child);
	};
	visit(root);
	return out;
}

/** Whether `name` contains a map-definition word (per word: `legend_node`, `mapSources`). */
export function isMapWord(name: string): boolean {
	const words = name
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.split(/[^A-Za-z0-9]+/)
		.map((word) => word.toLowerCase());
	return words.some((word) => MAP_WORDS.has(word));
}

/** The value of a key that is a literal (`'b'`, `` `b` ``), or null. */
function literalKey(key: Node): string | null {
	if (key.type === 'StringLiteral') return key.value as string;
	if (key.type !== 'TemplateLiteral' || (key.expressions as unknown[]).length > 0) return null;
	const [quasi] = key.quasis as Node[];
	const value = quasi?.value as { cooked?: string | null } | undefined;
	return value?.cooked ?? null;
}

/** A property or member name when `node` carries one (`a.b`, `a?.b`, `a['b']`, `{ b: … }`, `{ ['b']: … }`). */
function keyNameOf(node: Node): string | null {
	const key = MEMBERS.has(node.type) ? node.property : node.key;
	if (!isNode(key)) return null;
	if (node.computed === true) return literalKey(key);
	if (key.type === 'Identifier') return key.name as string;
	if (key.type === 'PrivateName' && isNode(key.id)) return `#${key.id.name as string}`;
	return key.type === 'StringLiteral' ? (key.value as string) : null;
}

/** The sink `node` is, if any: a sink-named member or key, or `document.write(ln)`. */
function sinkOf(node: Node): string | null {
	if (!MEMBERS.has(node.type) && node.type !== 'ObjectProperty') return null;
	const name = keyNameOf(node);
	if (name === null) return null;
	if (SINK_NAMES.has(name)) return name;
	const object = node.object;
	const onDocument = isNode(object) && object.type === 'Identifier' && object.name === 'document';
	return onDocument && (name === 'write' || name === 'writeln') ? `document.${name}` : null;
}

/** What one unit holds: its string text, and the sinks it names. */
interface Features {
	markup: boolean;
	sinks: string[];
}

/** The features of `node`'s subtree, NOT descending into nested functions. */
function featuresOf(node: Node): Features {
	const features: Features = { markup: false, sinks: [] };
	for (const current of ownNodes(node)) {
		if (current.type === 'StringLiteral' && MARKUP.test(current.value as string))
			features.markup = true;
		if (current.type === 'TemplateElement') {
			const value = current.value as { cooked?: string | null; raw: string };
			if (MARKUP.test(value.cooked ?? value.raw)) features.markup = true;
		}
		const sink = sinkOf(current);
		if (sink !== null) features.sinks.push(sink);
	}
	return features;
}

// ---------------------------------------------------------------------------
// scopes: taint, aliases, `this`
// ---------------------------------------------------------------------------

/** A sink a name stands for, and how many of its arguments a `.bind` already supplied. */
interface Alias {
	sink: string;
	shift: number;
}

/** A function's scope: what it learned (taint, aliases, names of `this`), and the scope around it. */
interface Scope {
	parent: Scope | null;
	tainted: Set<string>;
	aliases: Map<string, Alias>;
	thisNames: Set<string>;
}

/** A node and the scope it sits in. */
interface Scoped {
	node: Node;
	scope: Scope;
}

/** What the whole file knows: its root scope and the escapers it may trust. */
interface FileFacts {
	root: Scope;
	escapers: ReadonlySet<string>;
}

function newScope(parent: Scope | null): Scope {
	return { parent, tainted: new Set(), aliases: new Map(), thisNames: new Set() };
}

function isTainted(scope: Scope | null, name: string): boolean {
	for (let current = scope; current !== null; current = current.parent) {
		if (current.tainted.has(name)) return true;
	}
	return false;
}

function aliasOf(scope: Scope | null, name: string): Alias | null {
	for (let current = scope; current !== null; current = current.parent) {
		const alias = current.aliases.get(name);
		if (alias !== undefined) return alias;
	}
	return null;
}

function isThisName(scope: Scope | null, name: string): boolean {
	for (let current = scope; current !== null; current = current.parent) {
		if (current.thisNames.has(name)) return true;
	}
	return false;
}

/** The dotted path of a member chain (`this.a.b`, `o.label`; a name of `this` reads as `this`), or null. */
function memberPath(node: Node, scope: Scope): string | null {
	if (node.type === 'ThisExpression') return 'this';
	if (node.type === 'Identifier') {
		const name = node.name as string;
		return isThisName(scope, name) ? 'this' : name;
	}
	if (!MEMBERS.has(node.type) || !isNode(node.object)) return null;
	const name = keyNameOf(node);
	const base = name === null ? null : memberPath(node.object, scope);
	return base === null ? null : `${base}.${name}`;
}

/** Whether this ONE node is a mention: a map word, a tainted name, a tainted member path. */
function nodeMentions(scope: Scope, node: Node): boolean {
	if (node.type === 'Identifier') {
		const name = node.name as string;
		return isMapWord(name) || isTainted(scope, name);
	}
	if (!MEMBERS.has(node.type)) return false;
	const path = memberPath(node, scope);
	return path?.includes('.') === true && isTainted(scope, path);
}

/** Whether `node` (nested functions aside) mentions in `scope`. */
function mentionsIn(scope: Scope, node: Node): boolean {
	return ownNodes(node).some((current) => nodeMentions(scope, current));
}

/** Every node of the tree with its scope, plus the scope each function opens. */
function scopedNodes(root: Node): { all: Scoped[]; opened: Map<Node, Scope>; rootScope: Scope } {
	const all: Scoped[] = [];
	const opened = new Map<Node, Scope>();
	const rootScope = newScope(null);
	const visit = (node: Node, scope: Scope): void => {
		all.push({ node, scope });
		const inner = FUNCTIONS.has(node.type) ? newScope(scope) : scope;
		if (inner !== scope) opened.set(node, inner);
		for (const child of childrenOf(node)) visit(child, inner);
	};
	visit(root, rootScope);
	return { all, opened, rootScope };
}

/** The names a binding pattern declares (`x`, `{ a, b: c }`, `[d, ...e]`). */
function patternNames(pattern: unknown): string[] {
	if (!isNode(pattern)) return [];
	if (pattern.type === 'Identifier') return [pattern.name as string];
	return childrenOf(pattern).flatMap((child) => patternNames(child));
}

// ---------------------------------------------------------------------------
// calls: what sink a call reaches, and with which arguments
// ---------------------------------------------------------------------------

/** Whether a member callee is the layers control's constructor (`….control.layers`, `….Control.Layers`). */
function isLayersCallee(callee: Node): boolean {
	const name = keyNameOf(callee);
	const owner = name === 'layers' ? 'control' : name === 'Layers' ? 'Control' : null;
	const object = callee.object;
	if (owner === null || !isNode(object)) return false;
	if (object.type === 'Identifier') return object.name === owner;
	return MEMBERS.has(object.type) && keyNameOf(object) === owner;
}

/** The sink a callee names directly (a member or an alias), with the arguments a `.bind` already supplied. */
function sinkCallee(callee: Node, scope: Scope): Alias | null {
	if (callee.type === 'Identifier') return aliasOf(scope, callee.name as string);
	if (!MEMBERS.has(callee.type)) return null;
	if (isLayersCallee(callee)) return { sink: LAYERS, shift: 0 };
	const name = keyNameOf(callee);
	if (name !== null && ARGUMENT_SINKS.has(name)) return { sink: name, shift: 0 };
	const general = sinkOf(callee);
	return general === null ? null : { sink: general, shift: 0 };
}

/** A call resolved to its sink: the arguments AS THE SINK SEES THEM (`null` = supplied elsewhere). */
interface SinkCall {
	sink: string;
	args: (Node | null)[];
	/** `.bind(t, …)`: how many arguments it supplies to the bound function. */
	bound: number | null;
}

/** Inline spreads of array literals; holes become `null` (no value written). */
function flattenArguments(args: readonly unknown[]): (Node | null)[] {
	const out: (Node | null)[] = [];
	for (const arg of args) {
		if (!isNode(arg)) out.push(null);
		else if (
			arg.type === 'SpreadElement' &&
			isNode(arg.argument) &&
			arg.argument.type === 'ArrayExpression'
		) {
			out.push(...flattenArguments(arg.argument.elements as unknown[]));
		} else out.push(arg);
	}
	return out;
}

/** The sink `call` reaches, if any: directly, through an alias, or via `.call/.apply/.bind`. */
function resolveCall(call: Node, scope: Scope): SinkCall | null {
	const callee = call.callee;
	if (!isNode(callee)) return null;
	const given = call.arguments as unknown[];
	const direct = sinkCallee(callee, scope);
	if (direct !== null) {
		return {
			sink: direct.sink,
			args: [...Array(direct.shift).fill(null), ...flattenArguments(given)],
			bound: null,
		};
	}
	const form = MEMBERS.has(callee.type) ? keyNameOf(callee) : null;
	const target =
		form !== null && INDIRECT_CALLS.has(form) && isNode(callee.object)
			? sinkCallee(callee.object, scope)
			: null;
	if (target === null) return null;
	const prefix: (Node | null)[] = Array(target.shift).fill(null);
	if (form === 'apply') {
		const list = given[1];
		const spread = isNode(list) ? [{ type: 'SpreadElement', argument: list } as Node] : [];
		return { sink: target.sink, args: [...prefix, ...flattenArguments(spread)], bound: null };
	}
	const rest = flattenArguments(given.slice(1));
	return {
		sink: target.sink,
		args: [...prefix, ...rest],
		bound: form === 'bind' ? target.shift + rest.length : null,
	};
}

// ---------------------------------------------------------------------------
// what each node teaches its scope
// ---------------------------------------------------------------------------

/** Where a tainted name (or path) is recorded, and which. */
interface Taint {
	scope: Scope;
	names: string[];
}

/** The callback parameters of a call whose callee mentions: tainted in the callback's own scope. */
function callbackTaints(call: Node, scope: Scope, opened: Map<Node, Scope>): Taint[] {
	if (!isNode(call.callee) || !mentionsIn(scope, call.callee)) return [];
	const taints: Taint[] = [];
	for (const arg of call.arguments as unknown[]) {
		const inner = isNode(arg) && FUNCTIONS.has(arg.type) ? opened.get(arg) : undefined;
		if (isNode(arg) && inner !== undefined) {
			taints.push({ scope: inner, names: ((arg.params as unknown[]) ?? []).flatMap(patternNames) });
		}
	}
	return taints;
}

/** The taint an assignment target receives: a name, the names of a pattern, a member path (`this.*`: file-wide). */
function targetTaint(target: Node, scope: Scope, root: Scope): Taint | null {
	if (target.type === 'Identifier') return { scope, names: [target.name as string] };
	if (target.type === 'ObjectPattern' || target.type === 'ArrayPattern') {
		return { scope, names: patternNames(target) };
	}
	const path = MEMBERS.has(target.type) ? memberPath(target, scope) : null;
	if (path === null) return null;
	return { scope: path.startsWith('this.') ? root : scope, names: [path] };
}

/** What `node` taints: a declarator, an assignment, a class field or a loop fed from a mention, or a callback of one. */
function taintsOf(item: Scoped, opened: Map<Node, Scope>, root: Scope): Taint[] {
	const { node, scope } = item;
	const fed = (source: unknown): boolean => isNode(source) && mentionsIn(scope, source);
	if (node.type === 'VariableDeclarator') {
		return fed(node.init) ? [{ scope, names: patternNames(node.id) }] : [];
	}
	if (node.type === 'AssignmentExpression') {
		const taint = isNode(node.left) && fed(node.right) ? targetTaint(node.left, scope, root) : null;
		return taint === null ? [] : [taint];
	}
	if (node.type === 'ClassProperty' || node.type === 'ClassPrivateProperty') {
		const name = keyNameOf(node);
		return name !== null && fed(node.value) ? [{ scope: root, names: [`this.${name}`] }] : [];
	}
	if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
		return fed(node.right) ? [{ scope, names: patternNames(node.left) }] : [];
	}
	return CALLS.has(node.type) ? callbackTaints(node, scope, opened) : [];
}

/** The sink alias a value creates: a sink member, a `.bind` of one, another alias. */
function aliasFromValue(value: Node, scope: Scope): Alias | null {
	if (value.type === 'Identifier' || MEMBERS.has(value.type)) return sinkCallee(value, scope);
	if (!CALLS.has(value.type) || value.type === 'NewExpression') return null;
	const resolved = resolveCall(value, scope);
	return resolved?.bound != null ? { sink: resolved.sink, shift: resolved.bound } : null;
}

/** The aliases `node` declares: `const add = control.addOverlay(.bind(…))`, `add = …`, `const { addOverlay } = control`. */
function aliasesOf(node: Node, scope: Scope): [string, Alias][] {
	const pairs = (target: unknown, value: unknown): [string, Alias][] => {
		if (!isNode(target) || !isNode(value)) return [];
		if (target.type === 'Identifier') {
			const alias = aliasFromValue(value, scope);
			return alias === null ? [] : [[target.name as string, alias]];
		}
		if (target.type !== 'ObjectPattern') return [];
		return (target.properties as Node[]).flatMap((property): [string, Alias][] => {
			const key = property.type === 'ObjectProperty' ? keyNameOf(property) : null;
			const local =
				isNode(property.value) && property.value.type === 'Identifier' ? property.value : null;
			if (key === null || local === null) return [];
			const member = {
				type: 'MemberExpression',
				object: value,
				property: { type: 'Identifier', name: key },
			};
			const alias = sinkCallee(member as Node, scope);
			return alias === null ? [] : [[local.name as string, alias]];
		});
	};
	if (node.type === 'VariableDeclarator') return pairs(node.id, node.init);
	if (node.type === 'AssignmentExpression' && node.operator === '=')
		return pairs(node.left, node.right);
	return [];
}

/** `const self = this` (and `self = this`): a name the scan reads as `this`. */
function thisNameOf(node: Node): string | null {
	const [target, value] =
		node.type === 'VariableDeclarator'
			? [node.id, node.init]
			: node.type === 'AssignmentExpression'
				? [node.left, node.right]
				: [null, null];
	return isNode(target) &&
		target.type === 'Identifier' &&
		isNode(value) &&
		value.type === 'ThisExpression'
		? (target.name as string)
		: null;
}

/** Run the scope rules over the whole tree until no scope learns anything new. */
function propagate(all: readonly Scoped[], opened: Map<Node, Scope>, root: Scope): void {
	for (const { node, scope } of all) {
		const name = thisNameOf(node);
		if (name !== null) scope.thisNames.add(name);
	}
	for (let round = 0; round < 32; round += 1) {
		let learned = false;
		for (const item of all) {
			for (const [name, alias] of aliasesOf(item.node, item.scope)) {
				const known = item.scope.aliases.get(name);
				if (known?.sink === alias.sink && known.shift === alias.shift) continue;
				item.scope.aliases.set(name, alias);
				learned = true;
			}
			for (const { scope, names } of taintsOf(item, opened, root)) {
				for (const name of names) {
					if (scope.tainted.has(name)) continue;
					scope.tainted.add(name);
					learned = true;
				}
			}
		}
		if (!learned) return;
	}
}

// ---------------------------------------------------------------------------
// escapers: trusted by what they are
// ---------------------------------------------------------------------------

/** Every name the file BINDS, with each binding's node (import specifier, declarator, function, parameter). */
function bindingsOf(all: readonly Scoped[]): Map<string, Node[]> {
	const bindings = new Map<string, Node[]>();
	const add = (name: string, node: Node): void => {
		bindings.set(name, [...(bindings.get(name) ?? []), node]);
	};
	for (const { node } of all) {
		if (
			node.type === 'ImportSpecifier' ||
			node.type === 'ImportDefaultSpecifier' ||
			node.type === 'ImportNamespaceSpecifier'
		) {
			if (isNode(node.local)) add(node.local.name as string, node);
		}
		if (node.type === 'VariableDeclarator')
			for (const name of patternNames(node.id)) add(name, node);
		if (
			(node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') &&
			isNode(node.id)
		) {
			add(node.id.name as string, node);
		}
		if (FUNCTIONS.has(node.type)) {
			for (const name of ((node.params as unknown[]) ?? []).flatMap(patternNames)) add(name, node);
		}
		if (node.type === 'CatchClause') for (const name of patternNames(node.param)) add(name, node);
		if (node.type === 'AssignmentExpression' && isNode(node.left)) {
			for (const name of targetNames(node.left)) add(name, node);
		}
		if (
			node.type === 'UpdateExpression' &&
			isNode(node.argument) &&
			node.argument.type === 'Identifier'
		) {
			add(node.argument.name as string, node);
		}
	}
	return bindings;
}

/** The plain names an assignment target rebinds (a member target rebinds none). */
function targetNames(target: Node): string[] {
	if (target.type === 'Identifier') return [target.name as string];
	return target.type === 'ObjectPattern' || target.type === 'ArrayPattern'
		? patternNames(target)
		: [];
}

/** The import of the canonical escaper from `render_escape.js`. */
function isCanonicalImport(binding: Node, all: readonly Scoped[]): boolean {
	if (binding.type !== 'ImportSpecifier' || !isNode(binding.imported)) return false;
	const imported =
		binding.imported.type === 'Identifier' ? binding.imported.name : binding.imported.value;
	if (imported !== CANONICAL_ESCAPER) return false;
	const declaration = all.find(
		({ node }) =>
			node.type === 'ImportDeclaration' && (node.specifiers as Node[]).includes(binding),
	);
	const from = declaration === undefined ? null : (declaration.node.source as Node).value;
	return typeof from === 'string' && ESCAPER_MODULE.test(from);
}

/** The function a binding holds, when it holds one (`function f(p){}`, `const f = (p) => …`). */
function boundFunction(binding: Node): Node | null {
	if (binding.type === 'FunctionDeclaration') return binding;
	const init = binding.type === 'VariableDeclarator' ? binding.init : null;
	return isNode(init) &&
		(init.type === 'FunctionExpression' || init.type === 'ArrowFunctionExpression')
		? init
		: null;
}

/** The ONE expression a function's whole body returns, or null. */
function returnedExpression(fn: Node): Node | null {
	const body = fn.body;
	if (!isNode(body)) return null;
	if (body.type !== 'BlockStatement') return body;
	const statements = body.body as Node[];
	const only = statements.length === 1 ? statements[0] : null;
	return only?.type === 'ReturnStatement' && isNode(only.argument) ? only.argument : null;
}

/** A one-parameter function whose whole body returns a trusted escaper of that parameter (`String(p ?? '')` allowed). */
function delegatesToEscaper(binding: Node, trusted: ReadonlySet<string>): boolean {
	const fn = boundFunction(binding);
	const params = (fn?.params as Node[] | undefined) ?? [];
	const param =
		params.length === 1 && params[0]?.type === 'Identifier' ? (params[0].name as string) : null;
	const returned = fn === null ? null : returnedExpression(fn);
	if (param === null || returned === null || returned.type !== 'CallExpression') return false;
	const callee = returned.callee as Node;
	const args = returned.arguments as Node[];
	if (callee.type !== 'Identifier' || !trusted.has(callee.name as string) || args.length !== 1)
		return false;
	const inner = ownNodes(args[0] as Node);
	if (inner.some((node) => FUNCTIONS.has(node.type))) return false;
	return inner.every(
		(node) => node.type !== 'Identifier' || node.name === param || node.name === 'String',
	);
}

/** The names the file may treat as escapers: every binding of the name is the canonical import or delegates to one. */
function trustedEscapers(all: readonly Scoped[]): Set<string> {
	const bindings = bindingsOf(all);
	const trusted = new Set<string>();
	for (let round = 0; round < 8; round += 1) {
		let learned = false;
		for (const [name, nodes] of bindings) {
			if (trusted.has(name)) continue;
			if (
				nodes.every((node) => isCanonicalImport(node, all) || delegatesToEscaper(node, trusted))
			) {
				trusted.add(name);
				learned = true;
			}
		}
		if (!learned) break;
	}
	return trusted;
}

/** Whether `node` is WHOLLY escaped: an escaper call, or literals / `+` / templates / conditionals of escaped parts. */
function isEscaped(node: Node, escapers: ReadonlySet<string>): boolean {
	switch (node.type) {
		case 'CallExpression': {
			const callee = node.callee as Node;
			return callee.type === 'Identifier' && escapers.has(callee.name as string);
		}
		case 'StringLiteral':
		case 'NumericLiteral':
			return true;
		case 'TemplateLiteral':
			return (node.expressions as Node[]).every((expression) => isEscaped(expression, escapers));
		case 'BinaryExpression':
			return (
				node.operator === '+' &&
				isEscaped(node.left as Node, escapers) &&
				isEscaped(node.right as Node, escapers)
			);
		case 'ConditionalExpression':
			return (
				isEscaped(node.consequent as Node, escapers) && isEscaped(node.alternate as Node, escapers)
			);
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// the scan
// ---------------------------------------------------------------------------

/** The units to judge: simple statements, class fields, and the expression body of an arrow. */
function unitsOf(all: readonly Scoped[], opened: Map<Node, Scope>): Scoped[] {
	const units: Scoped[] = [];
	for (const { node, scope } of all) {
		if (SIMPLE_STATEMENTS.has(node.type)) units.push({ node, scope });
		const body = node.type === 'ArrowFunctionExpression' ? node.body : null;
		// the body of an arrow is judged in the arrow's own scope (its parameters live there)
		if (isNode(body) && body.type !== 'BlockStatement') {
			units.push({ node: body, scope: opened.get(node) ?? scope });
		}
	}
	return units;
}

/** Whether a WRITTEN argument writes a mention: not when it is wholly escaped. */
function writesMention(scope: Scope, arg: Node, facts: FileFacts): boolean {
	const value = arg.type === 'SpreadElement' && isNode(arg.argument) ? arg.argument : arg;
	return !isEscaped(value, facts.escapers) && mentionsIn(scope, value);
}

/** Whether one argument of the layers control writes a mention as a NAME: its keys, or itself. */
function layersArgumentMentions(scope: Scope, arg: Node, facts: FileFacts): boolean {
	if (arg.type !== 'ObjectExpression') return writesMention(scope, arg, facts);
	return (arg.properties as Node[]).some((property) => {
		if (property.type === 'SpreadElement') return writesMention(scope, property, facts);
		const key = property.key;
		return property.computed === true && isNode(key) && writesMention(scope, key, facts);
	});
}

/** Whether an ARGUMENT sink call writes a mention at its written position (a spread at or before it counts). */
function argumentSinkFed(scope: Scope, call: SinkCall, facts: FileFacts): boolean {
	const positions = call.sink === LAYERS ? [0, 1] : [ARGUMENT_SINKS.get(call.sink)];
	for (const position of positions) {
		if (position === undefined) return false;
		for (let index = 0; index <= position && index < call.args.length; index += 1) {
			const arg = call.args[index];
			if (arg === null || arg === undefined) continue;
			const spread = arg.type === 'SpreadElement';
			if (!spread && index !== position) continue;
			const fed =
				call.sink === LAYERS && !spread
					? layersArgumentMentions(scope, arg, facts)
					: writesMention(scope, arg, facts);
			if (fed) return true;
			if (spread) break; // past a spread, later positions are unknown: judged by the spread alone
		}
	}
	return false;
}

/** The calls of a unit (nested functions aside) and the sinks they reach. */
function sinkCallsOf(unit: Scoped): SinkCall[] {
	return ownNodes(unit.node)
		.filter((node) => CALLS.has(node.type))
		.map((node) => resolveCall(node, unit.scope))
		.filter((call): call is SinkCall => call !== null);
}

/**
 * A unit is FLAGGED when it mentions a map-definition value and holds a sink or markup, or
 * when an ARGUMENT sink's written argument mentions one (header).
 */
function isFlagged(unit: Scoped, facts: FileFacts): boolean {
	const calls = sinkCallsOf(unit);
	const isArgumentSink = (call: SinkCall): boolean =>
		call.sink === LAYERS || ARGUMENT_SINKS.has(call.sink);
	if (calls.some((call) => isArgumentSink(call) && argumentSinkFed(unit.scope, call, facts)))
		return true;
	const features = featuresOf(unit.node);
	const hasSink = features.sinks.length > 0 || calls.some((call) => !isArgumentSink(call));
	if (!hasSink && !features.markup) return false;
	return mentionsIn(unit.scope, unit.node);
}

function parseScoped(source: string): {
	all: Scoped[];
	opened: Map<Node, Scope>;
	facts: FileFacts;
} {
	const ast = parse(source, { sourceType: 'module', errorRecovery: false });
	const { all, opened, rootScope } = scopedNodes(ast.program as unknown as Node);
	propagate(all, opened, rootScope);
	return { all, opened, facts: { root: rootScope, escapers: trustedEscapers(all) } };
}

/**
 * The statements of `source` that hand a map-definition value to an HTML sink, as
 * `line: text`. THROWS on a source that does not parse — a file the scan cannot
 * read is a file outside the gate.
 */
export function htmlSinksOnMapDefinition(source: string): string[] {
	const { all, opened, facts } = parseScoped(source);
	return unitsOf(all, opened)
		.filter((unit) => isFlagged(unit, facts))
		.map(({ node }) => {
			const text = source.slice(node.start ?? 0, node.end ?? 0).replace(/\s+/g, ' ');
			return `${node.loc?.start.line ?? '?'}: ${text.slice(0, 140)}`;
		});
}

/** The names the scan treats as carrying a map-definition value, per function, joined (to diagnose a verdict). */
export function taintedNamesIn(source: string): string[] {
	const { all, opened } = parseScoped(source);
	const names = new Set<string>();
	for (const scope of opened.values()) for (const name of scope.tainted) names.add(name);
	for (const { scope } of all) for (const name of scope.tainted) names.add(name);
	return [...names].sort();
}

/** The names `source` may use as HTML escapers (header: an ESCAPER is trusted by what it IS). */
export function trustedEscapersIn(source: string): string[] {
	return [...parseScoped(source).facts.escapers].sort();
}
