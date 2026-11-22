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
 *      `DISTINCT ON` — and whose ORDER BY does not END in the sibling order
 *      (the constant's hole, or its exact expansion) is an offender. A pick by
 *      ADDRESS (a `tipo =` predicate: the row is named, not chosen) is out of
 *      the law.
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
	'src/core/resolve/security_access_datalist.ts': {
		count: 1,
		reason:
			'SC-5b, B9 removes it — the menu root-model pick (`WHERE model = ${rootModel} LIMIT 1`) is unordered; B9 owns the file and lands it with O15-1.',
	},
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
const PARENT_PREDICATE = /(?<![a-z0-9_])(?:[a-z_][a-z0-9_]*\.)?"?parent"?\s*(?:=|\bin\b|\bis\b)/;
const TIPO_ADDRESS = /(?<![a-z0-9_])(?:[a-z_][a-z0-9_]*\.)?"?tipo"?\s*=/;
const KEEPS_ONE_ROW = /\blimit\s+(?:1\b|\$\d|\$\{)|\bfetch\s+(?:first|next)\b|\bdistinct\s+on\b/;

/** Does the statement's ORDER BY END in the sibling order (the constant or its expansion)? */
function orderedBySiblingOrder(sql: string): boolean {
	const orderBy = sql.lastIndexOf('order by');
	if (orderBy === -1) return false;
	const tail = sql
		.slice(orderBy + 'order by'.length)
		.replace(/\b(?:limit|offset|fetch)\b.*$/, '')
		.trim();
	return (
		/(?:^|,\s*)\$\{\s*dd_ontology_sibling_order_sql\s*\}$/.test(tail) ||
		tail === SIBLING_ORDER_EXPANSION ||
		tail.endsWith(`, ${SIBLING_ORDER_EXPANSION}`)
	);
}

/** The law's verdict on one SQL literal. */
function classifyStatement(text: string): StatementClass {
	const sql = normalized(text);
	if (!READS_DD_ONTOLOGY.test(sql) || !MODEL_PREDICATE.test(sql)) return 'not_in_law';
	if (orderedBySiblingOrder(sql)) return 'ordered';
	if (KEEPS_ONE_ROW.test(sql)) return TIPO_ADDRESS.test(sql) ? 'not_in_law' : 'unordered_pick';
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
