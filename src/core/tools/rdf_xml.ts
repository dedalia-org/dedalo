/**
 * RDF/XML parser (PHP tool_import_rdf uses EasyRdf; tool_import_rdf's subject
 * list reads it — tool_import_zotero reads Zotero's CSL-JSON export, csl_json.ts). A from-scratch parser — NO 3rd-party lib, per the
 * project mandate — covering the RDF/XML subset both tools need: a minimal XML
 * reader plus RDF subject/property extraction (rdf:about / typed nodes /
 * rdf:resource references / literal text).
 *
 * Not a full RDF 1.1 implementation (no reification, containers, or datatype/lang
 * tags beyond attributes) — enough to lift bibliographic records into the import
 * pipeline; richer graph features are ledgered.
 */

export interface XmlNode {
	tag: string;
	attrs: Record<string, string>;
	children: (XmlNode | string)[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** The highest Unicode code point; `String.fromCodePoint` throws a RangeError above it. */
const MAX_CODE_POINT = 0x10ffff;

/**
 * A numeric character reference's text, or the reference itself (kept verbatim)
 * when its number is not a Unicode code point — `&#x110000;` in a remote document
 * must not crash the parse with a RangeError.
 */
function numericReference(match: string, body: string): string {
	const code =
		body[1] === 'x' || body[1] === 'X'
			? Number.parseInt(body.slice(2), 16)
			: Number.parseInt(body.slice(1), 10);
	return Number.isFinite(code) && code <= MAX_CODE_POINT ? String.fromCodePoint(code) : match;
}

/** Decode the XML predefined entities and numeric character references. */
function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) =>
		body[0] === '#' ? numericReference(match, body) : (ENTITIES[body] ?? match),
	);
}

function parseTag(content: string): { tag: string; attrs: Record<string, string> } {
	const trimmed = content.trim();
	const spaceIdx = trimmed.search(/\s/);
	const tag = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
	const attrs: Record<string, string> = {};
	if (spaceIdx !== -1) {
		const attrText = trimmed.slice(spaceIdx);
		const re = /([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g;
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex-loop idiom.
		while ((m = re.exec(attrText)) !== null) {
			const key = m[1] ?? m[3];
			const value = m[2] ?? m[4] ?? '';
			if (key !== undefined) attrs[key] = decodeEntities(value);
		}
	}
	return { tag, attrs };
}

/** Parse an XML document into a tree rooted at a synthetic '#root'. */
export function parseXml(text: string): XmlNode {
	const root: XmlNode = { tag: '#root', attrs: {}, children: [] };
	const stack: XmlNode[] = [root];
	let i = 0;
	const n = text.length;
	while (i < n) {
		if (text[i] === '<') {
			if (text.startsWith('<!--', i)) {
				const end = text.indexOf('-->', i);
				i = end === -1 ? n : end + 3;
				continue;
			}
			if (text.startsWith('<?', i)) {
				const end = text.indexOf('?>', i);
				i = end === -1 ? n : end + 2;
				continue;
			}
			if (text.startsWith('<!', i)) {
				const end = text.indexOf('>', i);
				i = end === -1 ? n : end + 1;
				continue;
			}
			const end = text.indexOf('>', i);
			if (end === -1) break;
			if (text[i + 1] === '/') {
				if (stack.length > 1) stack.pop();
				i = end + 1;
				continue;
			}
			let inner = text.slice(i + 1, end);
			const selfClose = inner.trimEnd().endsWith('/');
			if (selfClose) inner = inner.trimEnd().slice(0, -1);
			const { tag, attrs } = parseTag(inner);
			const node: XmlNode = { tag, attrs, children: [] };
			(stack.at(-1) ?? root).children.push(node);
			if (!selfClose) stack.push(node);
			i = end + 1;
		} else {
			const next = text.indexOf('<', i);
			const raw = text.slice(i, next === -1 ? n : next);
			const decoded = decodeEntities(raw).trim();
			if (decoded !== '') (stack.at(-1) ?? root).children.push(decoded);
			i = next === -1 ? n : next;
		}
	}
	return root;
}

/** Find the first element (depth-first) whose tag satisfies `pred`. */
function findElement(node: XmlNode, pred: (tag: string) => boolean): XmlNode | null {
	for (const child of node.children) {
		if (typeof child === 'string') continue;
		if (pred(child.tag)) return child;
		const found = findElement(child, pred);
		if (found !== null) return found;
	}
	return null;
}

export interface RdfProperty {
	predicate: string;
	/** Literal text value (null when the property is a resource reference). */
	value: string | null;
	/** rdf:resource URI (null for literals). */
	resource: string | null;
}

export interface RdfSubject {
	/** rdf:about URI (null for blank nodes). */
	about: string | null;
	/** The subject's RDF type — the typed-node tag, or an rdf:type attr on Description. */
	type: string | null;
	properties: RdfProperty[];
}

/** An RDF field-map entry: which RDF predicate → which component tipo. */
export interface RdfMapEntry {
	predicate: string;
	component_tipo: string;
}

/** A record mapped from an RDF subject (matches import_execute.ts MappedRecord). */
export interface RdfMappedRecord {
	sectionId: number | null;
	fields: { component_tipo: string; values: string[] }[];
}

/**
 * Apply a predicate→component field-map to parsed RDF subjects (the RDF
 * field-map / class-map application). Each subject becomes one record; its
 * mapped predicates' literal-or-resource values populate the components. Subjects
 * with no mapped predicate are dropped. Pure over the subjects + map.
 */
export function applyRdfMap(
	subjects: readonly RdfSubject[],
	map: readonly RdfMapEntry[],
): RdfMappedRecord[] {
	const byPredicate = new Map(map.map((m) => [m.predicate, m.component_tipo]));
	const records: RdfMappedRecord[] = [];
	for (const subject of subjects) {
		const fields = new Map<string, string[]>();
		for (const prop of subject.properties) {
			const tipo = byPredicate.get(prop.predicate);
			if (tipo === undefined) continue;
			const value = prop.value ?? prop.resource ?? '';
			if (value === '') continue;
			const list = fields.get(tipo) ?? [];
			list.push(value);
			fields.set(tipo, list);
		}
		if (fields.size > 0) {
			records.push({
				sectionId: null,
				fields: [...fields].map(([component_tipo, values]) => ({ component_tipo, values })),
			});
		}
	}
	return records;
}

/** Extract RDF subjects from an RDF/XML document (rdf:Description or typed nodes). */
export function parseRdfXml(text: string): { subjects: RdfSubject[] } {
	const root = parseXml(text);
	// Standard RDF/XML wraps subjects in an rdf:RDF container; without it there is
	// no RDF graph to extract (non-RDF input → no subjects, not a crash).
	const rdfEl = findElement(root, (tag) => tag === 'rdf:RDF' || tag.endsWith(':RDF'));
	if (rdfEl === null) return { subjects: [] };
	const subjects: RdfSubject[] = [];
	for (const child of rdfEl.children) {
		if (typeof child === 'string') continue;
		const about = child.attrs['rdf:about'] ?? child.attrs.about ?? null;
		const type = child.tag === 'rdf:Description' ? (child.attrs['rdf:type'] ?? null) : child.tag;
		const properties: RdfProperty[] = [];
		for (const prop of child.children) {
			if (typeof prop === 'string') continue;
			const resource = prop.attrs['rdf:resource'] ?? null;
			const literal = prop.children.find((c): c is string => typeof c === 'string') ?? null;
			properties.push({ predicate: prop.tag, value: resource !== null ? null : literal, resource });
		}
		subjects.push({ about, type, properties });
	}
	return { subjects };
}
