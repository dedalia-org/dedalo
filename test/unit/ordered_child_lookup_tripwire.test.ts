/**
 * ORDERED-CHILD LOOKUP TRIPWIRE — "the first X of model M" is answered in
 * sibling order, never by whichever row the heap returns first (T2-SC-4,
 * 2026-11-22; the outcome gate is ordered_child_lookup_native).
 *
 * THE LAW. A read of `dd_ontology` that filters by MODEL and keeps ONE row
 * orders by the one sibling order, `DD_ONTOLOGY_SIBLING_ORDER_SQL`
 * (src/core/db/dd_ontology.ts: order_number, NULL last, tipo) — in practice by
 * calling `findFirstChildByModel` (src/core/ontology/resolver.ts). A parent may
 * hold two `section_map`, two `section_list`, two `section_list_thesaurus`
 * children: an unordered `LIMIT 1` answers by write order, and a hand-written
 * `ORDER BY order_number … , id` answers a tie by write order too.
 *
 * WHAT A VIOLATION MUST DO (an outcome, not a spelling — the scanner reads the
 * SQL a statement sends, never a function name):
 *
 *   A  PICK. A statement over `dd_ontology` with a `model` predicate that keeps
 *      one row — `LIMIT 1` / `LIMIT $n` / `LIMIT ${…}`, `FETCH FIRST|NEXT`, or
 *      `DISTINCT ON` — and whose ORDER BY is not EXACTLY the sibling order
 *      (the constant's hole, or its exact expansion; the one allowed lead is
 *      the statement's own DISTINCT ON keys) is an offender — `ORDER BY id,
 *      ${…}` picks by write order. A pick by ADDRESS (the model-filtered
 *      table's OWN `tipo` equated to one value: the row is named, not chosen)
 *      is out of the law; `tipo = ANY(…)` or the other table's `tipo` is no
 *      address.
 *   B  UNLIMITED CHILD-BY-MODEL. The realistic rewrite of an offender is to
 *      drop the `LIMIT 1` and keep `rows[0]`. So every statement with BOTH a
 *      `parent` predicate and a `model` predicate that is not ordered by the
 *      sibling order is a SET READ that must be enumerated below with what it
 *      does with the set — a new one is red until it is placed (ordered, or
 *      listed with its reason).
 *
 * ENUMERATED, EXACT AND SHRINK-ONLY. `PICK_EXEMPTIONS` (leg A) and
 * `SET_READS` (leg B) carry each file's EXACT statement count and a reason; a
 * count drift, or an entry whose file no longer matches, is red (delete it).
 * The ONE pick exemption is an offender owned by a later batch, named so that
 * batch deletes it.
 *
 * CORPUS: the shared write-path corpus (src/ + tools/ + scripts/, floor
 * WRITE_PATH_CORPUS_FLOOR); statements are the comment-stripped string and
 * template literals (test/helpers/sql_literals.ts), SQL comments stripped.
 * Floors: the scan sees ≥ MODEL_STATEMENT_FLOOR model-filtered dd_ontology
 * statements and the primitive itself as an ORDERED pick. Positive controls
 * drive the classifier with a synthetic offender of every clause.
 *
 * HONEST LIMITS: a statement assembled from parts none of which carries the
 * whole query (`'SELECT … FROM dd_ontology WHERE model = $1' + limit`) is read
 * per literal — the `LIMIT` half alone is no statement; the corpus has no such
 * shape. A model filter applied in JS over an unordered `WHERE parent = $1`
 * read is not a statement shape (getChildrenNodes sorts its rows by the same
 * order in JS — compareSiblingOrder).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DD_ONTOLOGY_SIBLING_ORDER_SQL } from '../../src/core/db/dd_ontology.ts';
import { extractSourceLiterals, normalizeSqlLiteral } from '../helpers/sql_literals.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import {
	REPO_ROOT,
	WRITE_PATH_CORPUS_FLOOR,
	writePathSourceFiles,
} from '../helpers/write_path_corpus.ts';

/** Leg A — picks that do not order by the sibling order, owned by a later batch. */
const PICK_EXEMPTIONS: Record<string, { count: number; reason: string }> = {
	'src/core/section/buttons.ts': {
		count: 1,
		reason:
			"the virtual section's exclude_elements pick orders `order_number NULLS LAST, id` — a tie answers by write order, where the virtual edit scope (virtual_scope.ts) answers it by tipo; B11 owns buttons.ts — read it through findFirstChildByModel there.",
	},
};

/** Leg B — unlimited child-by-model reads: the set is consumed as a set. */
const SET_READS: Record<string, { count: number; reason: string }> = {
	'src/core/db/dd_ontology.ts': {
		count: 1,
		reason:
			'aggregate (`jsonb_agg(DISTINCT c.model)`): WHICH list models a node has — no row is picked.',
	},
	'src/core/diffusion_bridge/diffusion_delete.ts': {
		count: 1,
		reason:
			'every owl:Class child is scanned for the one whose relations name the section — selected by content, not by position.',
	},
	'src/core/search/search_related.ts': {
		count: 1,
		reason: 'every dd627 matrix_table child is a relation table — the whole set is used.',
	},
	'src/core/section/buttons.ts': {
		count: 1,
		reason:
			'every button child is listed (ordered `order_number NULLS LAST, tipo`, the sibling order minus the C collation) — no row is picked.',
	},
	'src/core/section/list_definitions/section_list.ts': {
		count: 1,
		reason: 'every component_dataframe child is a frame tipo of the main — the whole set is used.',
	},
};

/** Anti-vacuity: model-filtered dd_ontology statements the scan must see (15 on 2026-11-22). */
const MODEL_STATEMENT_FLOOR = 12;

const SIBLING_ORDER_EXPANSION = DD_ONTOLOGY_SIBLING_ORDER_SQL.toLowerCase().replace(/\s+/g, ' ');

type StatementClass = 'not_in_law' | 'ordered' | 'unordered_pick' | 'set_read';

/** One statement, normalized: SQL comments out, whitespace collapsed, lower case. */
function normalized(text: string): string {
	return normalizeSqlLiteral(text).replace(/\s+/g, ' ').toLowerCase();
}

const READS_DD_ONTOLOGY =
	/\b(?:from|join)\s+(?:only\s+)?(?:"?public"?\.)?"?dd_ontology"?(?![a-z0-9_])/;
const MODEL_PREDICATE =
	/(?<![a-z0-9_])(?:[a-z_][a-z0-9_]*\.)?"?model"?\s*(?:=|<>|!=|~|\bin\b|\blike\b|\bilike\b|\bis\b|\bnot\b)/;
/** MODEL_PREDICATE with its alias captured. */
const MODEL_PREDICATE_ALIAS =
	/(?<![a-z0-9_])(?:([a-z_][a-z0-9_]*)\.)?"?model"?\s*(?:=|<>|!=|~|\bin\b|\blike\b|\bilike\b|\bis\b|\bnot\b)/g;
const PARENT_PREDICATE = /(?<![a-z0-9_])(?:[a-z_][a-z0-9_]*\.)?"?parent"?\s*(?:=|\bin\b|\bis\b)/;
const KEEPS_ONE_ROW = /\blimit\s+(?:1\b|\$\d|\$\{)|\bfetch\s+(?:first|next)\b|\bdistinct\s+on\b/;
const SIBLING_ORDER_HOLE = /^\$\{\s*dd_ontology_sibling_order_sql\s*\}$/;

/**
 * Does the statement's ORDER BY consist of the sibling order (the constant or
 * its exact expansion)? EXACTLY that — a key in front of it would decide the
 * pick before the sibling order is consulted (`ORDER BY id, ${…}` is write
 * order). The ONE allowed lead is the statement's own `DISTINCT ON (…)` key
 * list, verbatim: Postgres requires it there, and per group the sibling order
 * then picks.
 */
function orderedBySiblingOrder(sql: string): boolean {
	const orderBy = sql.lastIndexOf('order by');
	if (orderBy === -1) return false;
	const tail = sql
		.slice(orderBy + 'order by'.length)
		.replace(/\b(?:limit|offset|fetch)\b.*$/, '')
		.trim();
	const isSiblingOrder = (text: string): boolean =>
		SIBLING_ORDER_HOLE.test(text) || text === SIBLING_ORDER_EXPANSION;
	if (isSiblingOrder(tail)) return true;
	const distinctOn = /\bdistinct\s+on\s*\(([^)]*)\)/.exec(sql);
	if (distinctOn === null) return false;
	const lead = (distinctOn[1] as string)
		.split(',')
		.map((key) => key.trim())
		.join(', ');
	return tail.startsWith(`${lead}, `) && isSiblingOrder(tail.slice(lead.length + 2).trim());
}

/** Every alias the statement filters by MODEL ('' = unqualified). */
function modelAliases(sql: string): Set<string> {
	const aliases = new Set<string>();
	for (const match of sql.matchAll(MODEL_PREDICATE_ALIAS)) aliases.add(match[1] ?? '');
	return aliases;
}

/** `<alias>.tipo` (bare `tipo` for '') as a regex source. */
function tipoOf(alias: string): string {
	return alias === ''
		? '(?<![a-z0-9_."])"?tipo"?(?![a-z0-9_])'
		: String.raw`(?<![a-z0-9_])${alias}\."?tipo"?(?![a-z0-9_])`;
}

/** `= <one value>` — never a set comparison (`= ANY (…)` / `SOME` / `ALL`). */
const EQUALS_ONE = String.raw`\s*=(?!\s*(?:any|some|all)\s*\()`;

/**
 * Is the PICKED row named, not chosen by position? Every model-filtered alias
 * must have its OWN `tipo` equated to one value — a bind, a literal, a column
 * or an expression (`t.tipo = rel.link->>'tipo'`: the row a relation names) —
 * never a set (`tipo = ANY($1)`, `tipo IN (…)`). A join that addresses the
 * OTHER table (`ON p.tipo = c.parent`) leaves `c`, the picked table, unnamed.
 * A statement without a JOIN reads one table, so a bare `tipo = $1` names it
 * whatever alias the model predicate carries.
 */
function pickedRowIsAddressed(sql: string): boolean {
	const named = (alias: string): boolean =>
		new RegExp(String.raw`${tipoOf(alias)}${EQUALS_ONE}|[^=<>!]=\s*${tipoOf(alias)}`).test(sql);
	const singleTable = !/\bjoin\b/.test(sql);
	return [...modelAliases(sql)].every(
		(alias) => named(alias) || (singleTable && alias !== '' && named('')),
	);
}

/** The law's verdict on one SQL literal. */
function classifyStatement(text: string): StatementClass {
	const sql = normalized(text);
	if (!READS_DD_ONTOLOGY.test(sql) || !MODEL_PREDICATE.test(sql)) return 'not_in_law';
	if (orderedBySiblingOrder(sql)) return 'ordered';
	if (KEEPS_ONE_ROW.test(sql)) return pickedRowIsAddressed(sql) ? 'not_in_law' : 'unordered_pick';
	return PARENT_PREDICATE.test(sql) ? 'set_read' : 'not_in_law';
}

interface Census {
	files: number;
	modelStatements: number;
	ordered: Map<string, number>;
	picks: Map<string, number>;
	sets: Map<string, number>;
}

function bump(map: Map<string, number>, file: string): void {
	map.set(file, (map.get(file) ?? 0) + 1);
}

function takeCensus(): Census {
	const census: Census = {
		files: 0,
		modelStatements: 0,
		ordered: new Map(),
		picks: new Map(),
		sets: new Map(),
	};
	for (const file of writePathSourceFiles()) {
		census.files++;
		const code = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
		for (const literal of extractSourceLiterals(code)) {
			const verdict = classifyStatement(literal.text);
			const sql = normalized(literal.text);
			if (READS_DD_ONTOLOGY.test(sql) && MODEL_PREDICATE.test(sql)) census.modelStatements++;
			if (verdict === 'ordered') bump(census.ordered, file);
			else if (verdict === 'unordered_pick') bump(census.picks, file);
			else if (verdict === 'set_read') bump(census.sets, file);
		}
	}
	return census;
}

const census = takeCensus();

function asCounts(entries: Record<string, { count: number }>): Record<string, number> {
	return Object.fromEntries(Object.entries(entries).map(([file, { count }]) => [file, count]));
}

describe('ordered-child lookup law (T2-SC-4)', () => {
	test('the corpus and the scan are not vacuous', () => {
		expect(census.files).toBeGreaterThanOrEqual(WRITE_PATH_CORPUS_FLOOR);
		expect(census.modelStatements).toBeGreaterThanOrEqual(MODEL_STATEMENT_FLOOR);
		// the primitive itself is seen, and seen as an ORDERED pick
		expect(census.ordered.get('src/core/ontology/resolver.ts') ?? 0).toBeGreaterThanOrEqual(1);
	});

	test('A — every pick of a model orders by the sibling order (exemptions exact)', () => {
		expect(
			Object.fromEntries(census.picks),
			'A dd_ontology read keeps ONE row of a model without ORDER BY ${DD_ONTOLOGY_SIBLING_ORDER_SQL}. Read it through findFirstChildByModel (ontology/resolver.ts). A listed file whose count fell: lower or delete its PICK_EXEMPTIONS entry.',
		).toEqual(asCounts(PICK_EXEMPTIONS));
	});

	test('B — every unordered child-by-model read is an enumerated set read (exact)', () => {
		expect(
			Object.fromEntries(census.sets),
			'A dd_ontology read filters by parent AND model without the sibling order. If one row of it is used, read it through findFirstChildByModel; if the set is used, list it in SET_READS with what it does with the set. A listed file whose count fell: lower or delete its entry.',
		).toEqual(asCounts(SET_READS));
	});

	test('every entry carries a reason', () => {
		for (const entry of [...Object.values(PICK_EXEMPTIONS), ...Object.values(SET_READS)]) {
			expect(entry.reason.length).toBeGreaterThan(20);
		}
	});
});

describe('positive controls — the classifier sees every clause', () => {
	const PRIMITIVE = 'DD_ONTOLOGY_SIBLING_ORDER_SQL';
	test('an unordered LIMIT 1 child-by-model read is an offending pick', () => {
		expect(
			classifyStatement(
				"SELECT properties FROM dd_ontology WHERE parent = $1 AND model = 'section_list_thesaurus' LIMIT 1",
			),
		).toBe('unordered_pick');
		// a model-only pick (no parent) is a pick too
		expect(classifyStatement('SELECT tipo FROM dd_ontology WHERE model = ${m} LIMIT 1')).toBe(
			'unordered_pick',
		);
		// FETCH FIRST and DISTINCT ON keep one row as well
		expect(
			classifyStatement(
				'select tipo from dd_ontology where parent = $1 and model in ($2) fetch first 1 rows only',
			),
		).toBe('unordered_pick');
		expect(
			classifyStatement(
				'SELECT DISTINCT ON (parent) tipo FROM dd_ontology WHERE model = $1 ORDER BY parent, tipo',
			),
		).toBe('unordered_pick');
	});

	test('a hand-written order with a write-order tie is an offending pick', () => {
		expect(
			classifyStatement(
				"SELECT relations FROM dd_ontology WHERE parent = $1 AND model = 'exclude_elements' ORDER BY order_number NULLS LAST, id LIMIT 1",
			),
		).toBe('unordered_pick');
		expect(
			classifyStatement(
				'SELECT tipo FROM dd_ontology WHERE parent = $1 AND model = $2 ORDER BY order_number LIMIT 1',
			),
		).toBe('unordered_pick');
	});

	test('the sibling order — the constant or its exact expansion — is ordered', () => {
		expect(
			classifyStatement(
				`SELECT tipo FROM dd_ontology WHERE parent = $1 AND model = $2 ORDER BY \${${PRIMITIVE}} LIMIT 1`,
			),
		).toBe('ordered');
		expect(
			classifyStatement(
				`SELECT tipo FROM dd_ontology WHERE parent = $1 AND model = $2 ORDER BY ${DD_ONTOLOGY_SIBLING_ORDER_SQL} LIMIT 1`,
			),
		).toBe('ordered');
		expect(
			classifyStatement(
				`SELECT DISTINCT ON (parent, model) tipo FROM dd_ontology WHERE model IN ('a') ORDER BY parent, model, \${${PRIMITIVE}}`,
			),
		).toBe('ordered');
	});

	test('dropping the LIMIT keeps the read in the law (set read, must be listed)', () => {
		expect(
			classifyStatement(
				"SELECT properties FROM dd_ontology WHERE parent = $1 AND model = 'section_list_thesaurus'",
			),
		).toBe('set_read');
		// an SQL comment cannot hide a predicate
		expect(
			classifyStatement(
				"SELECT properties FROM dd_ontology WHERE parent = $1 AND /* x */ model = 'section_map'",
			),
		).toBe('set_read');
	});

	test('a key IN FRONT of the sibling order decides the pick — offending (B6 review L1a)', () => {
		// write order first, the sibling order only breaks its (impossible) ties
		expect(
			classifyStatement(
				`SELECT tipo FROM dd_ontology WHERE parent = $1 AND model = $2 ORDER BY id, \${${PRIMITIVE}} LIMIT 1`,
			),
		).toBe('unordered_pick');
		expect(
			classifyStatement(
				`SELECT tipo FROM dd_ontology WHERE parent = $1 AND model = $2 ORDER BY id, ${DD_ONTOLOGY_SIBLING_ORDER_SQL} LIMIT 1`,
			),
		).toBe('unordered_pick');
		// a lead is allowed ONLY as the statement's own DISTINCT ON keys
		expect(
			classifyStatement(
				`SELECT tipo FROM dd_ontology WHERE parent = $1 AND model = $2 ORDER BY parent, \${${PRIMITIVE}} LIMIT 1`,
			),
		).toBe('unordered_pick');
		expect(
			classifyStatement(
				`SELECT DISTINCT ON (parent) tipo FROM dd_ontology WHERE model = $1 ORDER BY parent, id, \${${PRIMITIVE}}`,
			),
		).toBe('unordered_pick');
	});

	test("a set comparison or the OTHER table's address names no row — offending (B6 review L1b)", () => {
		expect(
			classifyStatement(
				'SELECT c.tipo FROM dd_ontology c WHERE c.parent = $1 AND c.model = $2 AND c.tipo = ANY($3) LIMIT 1',
			),
		).toBe('unordered_pick');
		expect(
			classifyStatement(
				'SELECT tipo FROM dd_ontology WHERE parent = $1 AND model = $2 AND tipo = any ($3) LIMIT 1',
			),
		).toBe('unordered_pick');
		expect(
			classifyStatement(
				"SELECT c.tipo FROM dd_ontology p JOIN dd_ontology c ON p.tipo = c.parent WHERE p.tipo = $1 AND c.model = 'section_map' LIMIT 1",
			),
		).toBe('unordered_pick');
		// control: the picked table's OWN tipo named by a relation is an address
		expect(
			classifyStatement(
				"SELECT t.tipo FROM dd_ontology s, jsonb_array_elements(s.relations) AS rel(link) JOIN dd_ontology t ON t.tipo = rel.link->>'tipo' AND t.model = 'matrix_table' WHERE s.tipo = $1 LIMIT 1",
			),
		).toBe('not_in_law');
	});

	test('an address pick, a model-less read and another table are outside the law', () => {
		expect(classifyStatement('SELECT term, model FROM dd_ontology WHERE tipo = $1 LIMIT 1')).toBe(
			'not_in_law',
		);
		expect(
			classifyStatement(
				"SELECT t.tipo FROM dd_ontology s JOIN dd_ontology t ON t.tipo = s.x AND t.model = 'matrix_table' WHERE s.tipo = $1 LIMIT 1",
			),
		).toBe('not_in_law');
		expect(classifyStatement('SELECT tipo FROM dd_ontology WHERE parent = $1 LIMIT 1')).toBe(
			'not_in_law',
		);
		expect(
			classifyStatement('SELECT tipo FROM dd_ontology_backup WHERE parent = $1 AND model = $2'),
		).toBe('not_in_law');
		// model_tipo is not the model column
		expect(
			classifyStatement(
				'SELECT tipo FROM dd_ontology WHERE parent = $1 AND model_tipo = $2 LIMIT 1',
			),
		).toBe('not_in_law');
	});
});
