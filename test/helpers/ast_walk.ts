/**
 * A SMALL READER FOR BABEL ASTs — what the source-census gates share.
 *
 * Several tripwires (the door census in `ssrf_one_guard_tripwire`, the limiter census in
 * `module_state_tripwire`) must follow BINDINGS, not spellings: a regex over source text
 * misses an aliased import, a namespace member, a table of values, a class field. They parse
 * with `@babel/parser` and walk the tree; the walk, the binding-pattern reader and the two
 * name readers below are the parts that do not depend on what a gate is looking for, so
 * they live once, here.
 */

/** A Babel node, read structurally: only the fields a gate asks for are typed. */
export type AstNode = { type: string; [key: string]: unknown };

/** Keys that hold source positions or comments, never code. */
export const NOT_CODE_KEYS: ReadonlySet<string> = new Set([
	'loc',
	'extra',
	'leadingComments',
	'trailingComments',
	'innerComments',
]);

/** An identifier or string-literal name (`import { 'x' as y }` is legal). */
export function nameOf(node: unknown): string {
	const named = node as { name?: string; value?: string } | null | undefined;
	return named?.name ?? named?.value ?? '';
}

/** A module specifier / property name written as a literal, or null. */
export function literalSpecifier(node: unknown): string | null {
	const literal = node as AstNode | undefined;
	if (literal?.type === 'StringLiteral') return literal.value as string;
	const quasis = literal?.quasis as Array<{ value: { cooked: string } }> | undefined;
	if (literal?.type === 'TemplateLiteral' && (literal.expressions as unknown[]).length === 0) {
		return quasis?.[0]?.value.cooked ?? null;
	}
	return null;
}

/** Every identifier a binding pattern introduces (`{ a, b: [c] }`, `[d, ...e]`, `f = 1`). */
export function patternNames(pattern: unknown): string[] {
	const node = pattern as AstNode | null | undefined;
	if (node === null || node === undefined) return [];
	switch (node.type) {
		case 'Identifier':
			return [node.name as string];
		case 'ObjectPattern':
			return (node.properties as AstNode[]).flatMap((property) =>
				patternNames(property.type === 'RestElement' ? property.argument : property.value),
			);
		case 'ArrayPattern':
			return (node.elements as unknown[]).flatMap(patternNames);
		case 'AssignmentPattern':
			return patternNames(node.left);
		case 'RestElement':
			return patternNames(node.argument);
		default:
			return [];
	}
}

/**
 * Visit every node under `node`, with the chain of its ancestors (the program's statement
 * first, the nearest parent last). Pre-order; a node's children are visited after it.
 */
export function walkAst(
	node: unknown,
	ancestors: readonly AstNode[],
	visit: (node: AstNode, ancestors: readonly AstNode[]) => void,
): void {
	if (Array.isArray(node)) {
		for (const child of node) walkAst(child, ancestors, visit);
		return;
	}
	if (node === null || typeof node !== 'object' || typeof (node as AstNode).type !== 'string') {
		return;
	}
	visit(node as AstNode, ancestors);
	const here = [...ancestors, node as AstNode];
	for (const [key, child] of Object.entries(node)) {
		if (!NOT_CODE_KEYS.has(key) && typeof child === 'object') walkAst(child, here, visit);
	}
}

/**
 * Is this identifier a NAME in a position that refers to nothing — a non-computed property
 * of a member expression, or the key of an object / class property? (A shorthand
 * `{ x }` has a separate value node, which IS a reference.)
 */
export function isNameOnly(node: AstNode, parent: AstNode | undefined): boolean {
	if (parent === undefined) return false;
	if (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') {
		return parent.property === node && parent.computed !== true;
	}
	if (parent.type === 'ObjectProperty' || parent.type === 'ClassProperty') {
		return parent.key === node && parent.computed !== true;
	}
	return false;
}

/** Is `member` (a MemberExpression) a read of the property `name`, spelled `.name` or `['name']`? */
export function readsProperty(member: AstNode, name: string): boolean {
	const property = member.property as AstNode;
	return member.computed === true
		? literalSpecifier(property) === name
		: property.type === 'Identifier' && property.name === name;
}
