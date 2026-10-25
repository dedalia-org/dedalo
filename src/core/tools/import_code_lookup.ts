/**
 * CODE → RECORD ADDRESS, for the mapped-import doors (MARC21; tool_import_rdf's
 * linked terms, matched by their IRI in a component_iri; the Zotero door is the
 * next caller the day its parser is re-ported — see the per-door notes below).
 *
 * WHY THIS MODULE EXISTS (audit DATA-08, closed 2026-08-30). An import file
 * carries a FOREIGN identifier: a library control number, a Zotero key, an
 * accession number. The MARC door used to hand that value to the shared import
 * executor AS THE section_id — so a control number of '42' wrote onto record 42
 * of the target section, whatever curated record already lived there, and when
 * no such row existed `saveComponentData`'s upsert branch minted one at that
 * meaningless id (save_component.ts :1064). Both were reported as success.
 *
 * The frozen engine never confused the two: `get_section_id_from_code`
 * (v7_php_frozen tools/tool_import_marc21/class.tool_import_marc21.php :1202,
 * and its twin in tool_import_zotero :1085) SEARCHED the identifier against the
 * section's own CODE component and let `resolve_target_section` create a record
 * when the search found none. That is the law this module restores, in the
 * engine's own search path rather than in a second hand-rolled query.
 *
 * THREE PROPERTIES A CALLER GETS:
 *
 *   1. THE SEARCH IS THE ENGINE'S. The lookup is an ordinary SQO run through
 *      `buildSearchSql` — the same assembler the list, the picker and every
 *      other search go through — so a code lookup can never drift from what the
 *      operator sees when they search that component by hand.
 *   2. THE MATCH IS EXACT, BY A SECOND READ. The `=` operator compares
 *      `f_unaccent(value) = f_unaccent(q)` and strips quotes from q
 *      (builder_string.ts :225-233), which is the right NARROWING but is not
 *      identity: 'Núñez-1' and 'Nunez-1' are one candidate set, and so are
 *      "O'Brien-1" and 'OBrien-1'. An identifier that resolves to a
 *      LOOK-ALIKE's record is the very defect this module closes, so every
 *      candidate's stored value is read back and compared as bytes; only an
 *      exact (trimmed) equal is an address.
 *   3. AMBIGUITY IS A REFUSAL, NOT A FIRST ROW. PHP took `limit 1` and wrote
 *      into whichever record the planner returned first. If two records already
 *      carry the identifier, no answer is honest — the caller is told, and
 *      writes nothing.
 *
 * SELECT-ONLY: this module resolves an address and never writes one.
 *
 * The heavy edges (the search assembler, the ontology resolver, the matrix
 * reader) are DYNAMIC imports, as they are in this directory's neighbours
 * (import_conform.ts, import_csv.ts): the tools layer sits above core, and the
 * import doors keep their static edge set small so a parser stays loadable when
 * an unrelated module below fails to parse.
 */

import { DedaloError } from '../errors/index.ts';
import { decodeHtmlSpecialChars } from '../resolve/html_text.ts';
import type { Principal } from '../security/permissions.ts';

/** The component an identifier is matched against: the section's CODE component. */
export interface ImportCodeTarget {
	/** The section being imported into — the same one the records are written to. */
	sectionTipo: string;
	/** The code component inside it (PHP: the `id` map entry's ddo_map tipo). */
	componentTipo: string;
}

/**
 * How many candidate rows the narrowing search asks for.
 *
 * (!) It was 2, on the reasoning that ">1 is already a refusal, so a third row
 * cannot change the answer". That is true of MATCHES and false of CANDIDATES,
 * which is what this cap bounds. Property 2 above is the whole reason: the
 * search compares `f_unaccent(value)` with quotes stripped, so "O'Brien-1",
 * 'OBrien-1' and 'O Brien-1' are ONE candidate set while only one of them is the
 * identifier. With three such look-alikes the cap could evict the byte-exact row
 * from the window, `matches` came back empty, this function answered "no such
 * code" — and the importer CREATED A DUPLICATE of a record that already existed.
 *
 * The cap still exists (a mis-pointed config naming a component that holds the
 * same word on thousands of records must not drag a section through the door),
 * but it is now high enough that a real look-alike cluster fits inside it, and
 * TRUNCATION IS DETECTED rather than silently answered — see the refusal below.
 */
const CANDIDATE_CAP = 50;

/** The stored values of one component on one record, as comparable strings. */
/**
 * ONE STORED ITEM AS COMPARABLE TEXT, or null when it carries none.
 *
 * A literal component stores `{lang, value}`; a value-less model stores something
 * else entirely, and a numeric code is compared by its text. NO lang filter: an
 * identifier is an identifier in every language slice, and the search leaf that
 * produced the candidate matched across langs too. Exported for the one other
 * identity comparison an importer makes by hand — tool_import_rdf's intermediate
 * path walk (the leaf of a ddo_map path holding the resource's identifier) — so
 * the two can never disagree on what "the same identifier" means. `html`: the
 * component stores markup, and its value is compared on its text
 * ({@link paragraphAsText}).
 */
export function itemAsText(item: unknown, html = false): string | null {
	const value = item !== null && typeof item === 'object' ? identifierOf(item) : item;
	if (typeof value === 'string') return (html ? paragraphAsText(value) : value).trim();
	if (typeof value === 'number') return String(value);
	return null;
}

/**
 * Plain text as the ONE paragraph an HTML component (render 'html' —
 * component_text_area) stores it: `&`, `<`, `>`, `"` escaped, wrapped in `<p>`.
 * The importers that write remote text into such a component build the item with
 * this, and the code lookup narrows with it, so the two cannot drift.
 */
export function textAsParagraph(text: string): string {
	const escaped = text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
	return `<p>${escaped}</p>`;
}

/**
 * The text of a stored HTML identifier: ONE wrapping paragraph removed and the
 * escaping {@link textAsParagraph} applies undone (plus the apostrophe forms an
 * editor writes, and the numeric spellings of `& < > " '`), in ONE pass. Anything else is kept as it is: an identifier holding more
 * markup than one paragraph is compared on that markup, and matches nothing.
 */
export function paragraphAsText(markup: string): string {
	const inner = /^\s*<p>([\s\S]*)<\/p>\s*$/i.exec(markup)?.[1] ?? markup;
	// ONE pass (html_text): a chain decodes `&amp;` last to stay single-decode,
	// and the html_text_tripwire refuses any `&amp;` decode outside html_text.
	return decodeHtmlSpecialChars(inner, { apos: true });
}

/**
 * The identifier an OBJECT item carries: its `value` (the literal families), else
 * its `iri` (component_iri stores `{id, iri, lang, title?}` and has no `value` —
 * without this branch an IRI could never be matched, and an importer keyed on
 * one, tool_import_rdf, would create a duplicate on every run).
 */
function identifierOf(item: object): unknown {
	const { value, iri } = item as { value?: unknown; iri?: unknown };
	return value ?? iri;
}

/** How the identifier is searched for, and read back, in one component's family. */
interface CodeQuery {
	/** The search operator that NARROWS to the identifier. */
	operator: string;
	/** The term searched for. */
	q: string;
	/** The component stores markup: a stored value is compared on its text. */
	html: boolean;
}

/**
 * The search that NARROWS to the identifier in this component's family.
 *
 * '=' is the string family's equality (builder_string 'equal'), but the iri
 * family has no single-char '=' — `classifyIri` reads '=<q>' as CONTAINS and
 * strips every '=' out of q first, so an IRI with a query string ('?a=b') could
 * never be found. '==' is the iri family's EXACT leaf (`f_unaccent(iri) =
 * f_unaccent(q)`).
 *
 * An HTML component (component_text_area) stores the identifier as the
 * paragraph `textAsParagraph` makes of it, so it is searched AS that paragraph
 * — the plain text equals no stored value, the lookup answered "none", and every
 * import created the same record again — with '==' (the string family's exact
 * leaf keeps an apostrophe in q; '=' strips it). Either way the byte comparison
 * below still decides, on the stored value's text.
 */
async function codeQueryFor(componentTipo: string, wanted: string): Promise<CodeQuery> {
	const { getModelByTipo } = await import('../ontology/resolver.ts');
	const { getComponentModel } = await import('../components/registry.ts');
	const model = await getModelByTipo(componentTipo);
	if (model === 'component_iri') return { operator: '==', q: wanted, html: false };
	if (model !== null && getComponentModel(model)?.render === 'html') {
		return { operator: '==', q: textAsParagraph(wanted), html: true };
	}
	return { operator: '=', q: wanted, html: false };
}

/**
 * The component's stored items, or NONE when this section cannot be read.
 *
 * Every un-readable shape answers with no items rather than a throw: a code lookup
 * that cannot read a section has found nothing there, which is a true answer and
 * keeps the caller's refusal logic in one place.
 */
async function readItems(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
): Promise<unknown[]> {
	const { getMatrixTableFromTipo, getModelByTipo } = await import('../ontology/resolver.ts');
	const { isMatrixTable, readMatrixRecord } = await import('../db/matrix.ts');
	const { readComponentItems } = await import('../resolve/component_data.ts');
	const table = await getMatrixTableFromTipo(sectionTipo);
	const model = await getModelByTipo(componentTipo);
	if (table === null || model === null || !isMatrixTable(table)) return [];
	const record = await readMatrixRecord(table, sectionTipo, sectionId);
	if (record === null) return [];
	return readComponentItems(record, componentTipo, model) ?? [];
}

async function storedValues(
	sectionTipo: string,
	sectionId: number,
	componentTipo: string,
	html: boolean,
): Promise<string[]> {
	// A VIRTUAL section whose declared matrix_table is not a readable record store
	// (dd15 -> matrix_time_machine, flat columns) has no record to read;
	// `readMatrixRecord` would throw on it (assertMatrixTable). Same guard the
	// widget reader uses (widget_common.ts :246). Every un-readable shape answers
	// with no items rather than a throw: a code lookup that cannot read a section
	// has found nothing there, which is a true answer.
	const items = await readItems(sectionTipo, sectionId, componentTipo);
	const values: string[] = [];
	for (const item of items) {
		const text = itemAsText(item, html);
		if (text !== null) values.push(text);
	}
	return values;
}

/**
 * Property 2 in force: the search NARROWED, the byte comparison DECIDES.
 *
 * Each candidate's stored value is read back and compared as bytes, because the
 * search matched `f_unaccent(value)` with quotes stripped — a fold that makes
 * 'Núñez-1' and 'Nunez-1' one candidate set. Only an exact (trimmed) equal of
 * one of `wanted` is an address; resolving to a look-alike's record is the
 * defect this module closes.
 */
async function byteExactMatches(
	candidates: readonly number[],
	target: ImportCodeTarget,
	wanted: ReadonlySet<string>,
	html: boolean,
): Promise<number[]> {
	const matches: number[] = [];
	for (const sectionId of candidates) {
		const values = await storedValues(target.sectionTipo, sectionId, target.componentTipo, html);
		if (values.some((value) => wanted.has(value))) matches.push(sectionId);
	}
	return matches;
}

/** How a lookup is scoped beyond the principal's section grant. */
export interface CodeLookupOptions {
	/**
	 * Answer the identifier's EXISTENCE across every project, not only the
	 * principal's (the server-only `skip_projects_filter`). For a caller that
	 * LINKS to the record it finds and never writes into it unchecked:
	 * tool_import_rdf's linked terms (v6 `get_resource_match` searched them so —
	 * an authority record another project holds is linked, never duplicated;
	 * any write into it still passes the record-scope door). An updating import
	 * (MARC) keeps the default: it writes INTO the record it resolves.
	 */
	readonly skipProjectsFilter?: boolean;
}

/**
 * The record id whose code component holds EXACTLY `code`, or null when no
 * record carries it (the caller's cue to CREATE one).
 *
 * Throws `resource.conflict` when more than one record carries it: an
 * identifier that names two records names neither.
 *
 * The principal is the CALLER'S, never absent: `buildSearchSql` treats a missing
 * principal as an internal unscoped search, and resolving an import against
 * records the operator cannot see would let one project's import silently
 * update another's record (record_pool.ts states the same rule for the same
 * reason).
 */
export async function findSectionIdByCode(
	target: ImportCodeTarget,
	code: string,
	principal: Principal,
	options: CodeLookupOptions = {},
): Promise<number | null> {
	const wanted = code.trim();
	if (wanted === '') return null;
	const query = await codeQueryFor(target.componentTipo, wanted);
	const candidates = await candidateIds(
		target,
		{ $and: [codeLeaf(target, query)] },
		{ principal, options, subject: `The identifier '${wanted}'` },
	);
	const matches = await byteExactMatches(candidates, target, new Set([wanted]), query.html);
	if (matches.length === 0) return null;
	if (matches.length > 1) {
		const sentence =
			`The identifier '${wanted}' is held by more than one record of section ${target.sectionTipo} ` +
			`(${matches.join(', ')}), so it names none of them. Nothing was imported — resolve the duplicate ` +
			`codes in ${target.componentTipo} first.`;
		throw lookupConflict(target, sentence);
	}
	return matches[0] as number;
}

/**
 * EVERY record whose code component holds EXACTLY one of `codes` (trimmed,
 * blanks dropped), in ONE search — an `$or` of the same narrowing leaf
 * {@link findSectionIdByCode} uses, decided by the same byte-exact second read.
 * Distinct ids, in the search's order; none is `[]`. Whether several are an
 * answer is the caller's question (tool_import_rdf: a term's equivalents name ONE
 * record, or a conflict). A full candidate window throws `resource.conflict`, as
 * there: TRUNCATION IS NOT AN ANSWER. The caller bounds how many codes one call
 * carries (each is a leaf of one statement).
 */
export async function findSectionIdsByCodes(
	target: ImportCodeTarget,
	codes: readonly string[],
	principal: Principal,
	options: CodeLookupOptions = {},
): Promise<number[]> {
	const wanted = [...new Set(codes.map((code) => code.trim()).filter((code) => code !== ''))];
	if (wanted.length === 0) return [];
	const queries = await Promise.all(wanted.map((code) => codeQueryFor(target.componentTipo, code)));
	const candidates = await candidateIds(
		target,
		{ $or: queries.map((query) => codeLeaf(target, query)) },
		{ principal, options, subject: `The ${wanted.length} identifiers ('${wanted[0]}'…)` },
	);
	const html = queries.some((query) => query.html);
	return byteExactMatches(candidates, target, new Set(wanted), html);
}

/**
 * The search leaf that narrows to one identifier. q_operator '=' is the engine's
 * EXACT-match operator (the single-char twin of '=='; '==' for an IRI or HTML
 * component, see codeQueryFor); the value travels as `q`, never glued into the
 * operator string, so an identifier that happens to start with an operator
 * character ('*x', '-x') is still read as data.
 */
function codeLeaf(target: ImportCodeTarget, query: CodeQuery): Record<string, unknown> {
	return {
		q: query.q,
		q_operator: query.operator,
		path: [{ section_tipo: target.sectionTipo, component_tipo: target.componentTipo }],
	};
}

/** Who searches, how widely, and how a refusal names what was searched. */
interface CandidateScope {
	readonly principal: Principal;
	readonly options: CodeLookupOptions;
	/** The refusal's subject ("The identifier 'x'"). */
	readonly subject: string;
}

/**
 * The NARROWING search: the ids of the records `filter` matches, through the
 * engine's own assembler, as the caller's principal. A full window is REFUSED.
 */
async function candidateIds(
	target: ImportCodeTarget,
	filter: Record<string, unknown>,
	scope: CandidateScope,
): Promise<number[]> {
	const { sanitizeClientSqo } = await import('../concepts/sqo.ts');
	const { buildSearchSql } = await import('../search/sql_assembler.ts');
	const { sql } = await import('../db/postgres.ts');
	const sqo = sanitizeClientSqo({
		section_tipo: [target.sectionTipo],
		filter,
		limit: CANDIDATE_CAP,
	});
	// THE CAP THE SEARCH WILL ACTUALLY HONOUR. `sanitizeClientSqo` clamps `limit`
	// to DEDALO_SEARCH_CLIENT_MAX_LIMIT, a per-install key — so on an install
	// that lowered it, the window is SMALLER than CANDIDATE_CAP and comparing the
	// row count against the constant would never detect truncation: the exact
	// record could be evicted, the lookup answers null, and the importer
	// creates a duplicate. Read the number the sanitizer left.
	const effectiveCap = Number(sqo.limit ?? CANDIDATE_CAP);
	// Server-only (sanitizeClientSqo strips it from a client SQO): set after it.
	sqo.skip_projects_filter = scope.options.skipProjectsFilter === true;
	const built = await buildSearchSql(sqo, { principal: scope.principal, idsOnly: true });
	const rows = (await sql.unsafe(built.sql, built.params as (string | number | null)[])) as {
		section_id: number;
	}[];
	// TRUNCATION IS NOT AN ANSWER. A full window means the search may have had
	// more to give, so neither "none" nor "exactly one" is provable: the missing
	// candidates could hold the byte-exact identifier (answering null would make
	// the caller create a duplicate of an existing record) or a SECOND copy of it
	// (answering an address would write into one of two records that share it).
	// Both are the defects this module exists to close, so it refuses instead.
	if (rows.length >= effectiveCap) {
		const sentence =
			`${scope.subject} matched the search cap of ${effectiveCap} candidate records ` +
			`in section ${target.sectionTipo}, so the result cannot be trusted either way — the ` +
			`record that truly holds it may lie outside that window. Nothing was imported. This ` +
			`almost always means ${target.componentTipo} is not an identifier component on this ` +
			`section (it holds a shared word rather than a unique code); check the import map.`;
		throw lookupConflict(target, sentence);
	}
	return rows.map((row) => Number(row.section_id));
}

/** The lookup's refusal: `resource.conflict`, its sentence public. */
function lookupConflict(target: ImportCodeTarget, sentence: string): DedaloError {
	return new DedaloError('resource.conflict', {
		message: sentence,
		publicMessage: sentence,
		coordinates: {
			section_tipo: target.sectionTipo,
			component_tipo: target.componentTipo,
		},
	});
}
