/**
 * A SEARCH TERM IS TEXT, NEVER A PROGRAM (DATA-34).
 *
 * Every `~*` operand in the search-builder family is compiled by Postgres as a
 * POSIX REGULAR EXPRESSION, so a curator typing `Denarius [sic]` used to get a
 * character class (matching `Denariuss`, `Denariusi`, `Denariusc`, …) and one
 * typing `sar(de` a regex SYNTAX ERROR surfacing as an internal failure.
 *
 * THE ESCAPE RUNS IN SQL, ON THE FAR SIDE OF f_unaccent (corrected
 * 2026-09-05). Every operand is normalized with `f_unaccent`, i.e. Postgres's
 * own unaccent dictionary, and that dictionary EXPANDS characters INTO
 * metacharacters (`×`→`*`, `©`→`(C)`, `…`→`...`, `∖`→`\`, `¿`→`?`, `⁅`→`[`,
 * `％`→`%` …). A TypeScript-side escape therefore neutralises metacharacters
 * that do not exist yet: measured, `Museo © 1998` compiled as `Museo (C) 1998`,
 * matched `Museo C 1998` and did NOT match the record that says `Museo © 1998`.
 * The ONE correct order is `f_regex_literal(f_unaccent(term))` — and
 * `f_like_literal(lower(f_unaccent(term)))` for the trigram pre-filter's LIKE.
 *
 * This gate is the INVARIANT, measured through the builders' own doors (pure
 * functions of q/operator/context, so no database):
 *
 *  - CENSUS, TOTAL: every file under src/core/search/builders/ whose CODE
 *    contains `~*` must appear in the probe table — derived from the tree,
 *    never hand-listed.
 *  - Every `~*` OPERAND, read off the emitted SQL, is the escaped form; no
 *    bare `f_unaccent(_Qn_)` survives inside one.
 *  - The bound value is the curator's RAW term: escaping it in TypeScript as
 *    well would double-escape (`\(` → `\\(`, a literal backslash).
 *  - THE BOUNDARY: the equality shapes ('=', '==', quoted literal) keep the
 *    plain `f_unaccent(_Q1_)` and the raw value — escaping them would break
 *    exact search.
 *  - THE FUNCTIONS EXIST WHERE THEY MUST: declared in db_pg_definitions.json
 *    (the maintenance rebuild) AND carried VERBATIM by the boot migration (an
 *    existing install, where a missing function means every contains search
 *    fails outright).
 *  - POSITIVE CONTROL: the pre-fix operand shape IS reported by the detector.
 *
 * HERMETIC: builder calls + file reads. No database.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import definitions from '../../src/core/db/db_pg_definitions.json';
import { buildIriFragment } from '../../src/core/search/builders/builder_iri.ts';
import { buildJsonFragment } from '../../src/core/search/builders/builder_json.ts';
import { buildStringFragment } from '../../src/core/search/builders/builder_string.ts';
import type {
	BuilderContext,
	BuilderResult,
	Fragment,
} from '../../src/core/search/builders/types.ts';
import {
	LIKE_LITERAL_FN,
	REGEX_LITERAL_FN,
	REGEX_META,
} from '../../src/core/search/builders/types.ts';
import { asSqlTipo } from '../../src/core/search/identifier_gate.ts';
import { searchBuilderFiles } from '../helpers/engine_source_corpus.ts';
import { migrationFileNames, migrationsSql } from '../helpers/migrations_corpus.ts';

// The walk roots are NOT chosen here: `searchBuilderFiles` and the migrations
// corpus own them (census_derivation_tripwire's shared-lister registry).

/** The declared metacharacter class as characters — from the engine's regex. */
const META_CHARS: string[] = (() => {
	const body = REGEX_META.source.replace(/^\[/, '').replace(/\]$/, '');
	const chars: string[] = [];
	for (let i = 0; i < body.length; i++) {
		if (body[i] === '\\') {
			i += 1;
			chars.push(body[i] as string);
			continue;
		}
		chars.push(body[i] as string);
	}
	return chars;
})();

/**
 * The OPERAND expression of every `~*` in `sentence`, read off the emitted SQL
 * by balanced parentheses — never assumed. Which expression a branch puts on
 * the right of the operator is exactly what a future edit could get wrong.
 */
function patternOperands(sentence: string): string[] {
	const operands: string[] = [];
	for (const match of sentence.matchAll(/~\*/g)) {
		let i = (match.index as number) + 2;
		while (sentence[i] === ' ') i += 1;
		const start = i;
		// identifier (possibly none, when the operand starts with '(')
		while (i < sentence.length && /[A-Za-z0-9_]/.test(sentence[i] as string)) i += 1;
		if (sentence[i] === '(') {
			let depth = 0;
			for (; i < sentence.length; i++) {
				if (sentence[i] === '(') depth += 1;
				else if (sentence[i] === ')') {
					depth -= 1;
					if (depth === 0) {
						i += 1;
						break;
					}
				}
			}
		}
		operands.push(sentence.slice(start, i));
	}
	return operands;
}

/** The token names bound INTO an operand. */
function operandTokens(operand: string): string[] {
	return [...new Set([...operand.matchAll(/_Q\d+_/g)].map((m) => m[0]))];
}

/**
 * What is left of an operand once every CORRECTLY escaped normalization is
 * removed. A bare `f_unaccent(_Qn_)` surviving here is the defect itself.
 */
function unescapedNormalizations(operand: string): string {
	return operand.replaceAll(
		new RegExp(`${REGEX_LITERAL_FN}\\(f_unaccent\\(_Q\\d+_\\)\\)`, 'g'),
		'',
	);
}

/**
 * The character class a declared escape function escapes, PARSED out of its own
 * `regexp_replace($1, '([…])', …)` body — so the SQL and the TypeScript
 * declaration cannot drift apart without this gate noticing.
 */
function sqlEscapedClass(add: string): string[] {
	const start = add.indexOf("'([");
	expect(start, 'the declared body carries no regexp_replace class').toBeGreaterThan(-1);
	const chars: string[] = [];
	for (let i = start + 3; i < add.length; i++) {
		const char = add[i] as string;
		if (char === '\\') {
			i += 1;
			chars.push(add[i] as string);
			continue;
		}
		if (char === ']') break;
		chars.push(char);
	}
	return chars;
}

function context(overrides: Partial<BuilderContext> = {}): BuilderContext {
	return {
		alias: 'm',
		column: 'string',
		tipo: asSqlTipo('test45', 'test context'),
		sectionTipo: 'test3',
		table: 'matrix_test',
		lang: 'lg-eng',
		translatable: true,
		model: 'component_input_text',
		...overrides,
	};
}

/** The probe term — one metacharacter run, no Dedalo wildcard, no quote. */
const TERM = 'Denarius [sic]';

/** A term whose METACHARACTERS ONLY EXIST AFTER f_unaccent — the corrected defect. */
const EXPANDING_TERM = 'Museo © 1998';

const PROBES: Record<
	string,
	{ shapes: string[]; run: (q: string, ctx: BuilderContext) => BuilderResult; ctx: BuilderContext }
> = {
	'builder_string.ts': {
		shapes: [TERM, `-${TERM}`, `*${TERM}`, `${TERM}*`, `*${TERM}*`, `!=*${TERM}*`, EXPANDING_TERM],
		run: (q, ctx) => buildStringFragment(q, null, false, ctx),
		ctx: context(),
	},
	'builder_json.ts': {
		shapes: [TERM, `-${TERM}`, `!=${TERM}`, `*${TERM}`, `${TERM}*`, `*${TERM}*`, EXPANDING_TERM],
		run: (q, ctx) => buildJsonFragment(q, null, ctx),
		ctx: context({ column: 'misc', model: 'component_json' }),
	},
	'builder_iri.ts': {
		shapes: [TERM, `-${TERM}`, `*${TERM}`, `${TERM}*`, `*${TERM}*`, EXPANDING_TERM],
		run: (q, ctx) => buildIriFragment(q, null, ctx),
		ctx: context({ column: 'iri', model: 'component_iri' }),
	},
};

/** Source with comments removed — the census counts EMITTED SQL, not prose. */
function codeOf(path: string): string {
	return readFileSync(path, 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/^\s*\/\/.*$/gm, '');
}

/** Every builder that emits a `~*` predicate at all — read from the tree. */
function patternEmittingBuilders(): string[] {
	return searchBuilderFiles()
		.filter((path) => codeOf(path).includes('~*'))
		.map((path) => basename(path));
}

function asFragment(result: BuilderResult): Fragment {
	expect(result).not.toBe(false);
	expect((result as Fragment).kind).toBe('fragment');
	return result as Fragment;
}

interface FunctionEntry {
	name: string;
	add: string;
	drop: string;
}
const declaredFunctions = definitions.ar_function as FunctionEntry[];

describe('search terms are literal — the escape census', () => {
	test('CENSUS is TOTAL: every `~*`-emitting builder is probed here', () => {
		const emitting = patternEmittingBuilders();
		// Corpus floor: three families emit `~*` today (string, json, iri). A
		// scan that found none — a renamed directory, a changed operator — would
		// make every leg below vacuous while staying green.
		expect(emitting.length).toBeGreaterThan(2);
		expect(emitting.sort()).toEqual(Object.keys(PROBES).sort());
	});

	test('the metacharacter class is non-trivial', () => {
		// 14 characters today; a class parsed to nothing would defeat the
		// detector rather than the escape.
		expect(META_CHARS.length).toBeGreaterThan(10);
		expect(META_CHARS).toContain('[');
		expect(META_CHARS).toContain('(');
	});

	test('EVERY `~*` operand escapes AFTER f_unaccent, in any builder', () => {
		let operandsChecked = 0;
		for (const [file, probe] of Object.entries(PROBES)) {
			for (const q of probe.shapes) {
				const built = asFragment(probe.run(q, probe.ctx));
				const operands = patternOperands(built.sentence);
				expect(operands.length, `${file} / ${q}: no ~* operand found`).toBeGreaterThan(0);
				for (const operand of operands) {
					expect(
						operand,
						`${file} / ${q}: operand ${operand} is not ${REGEX_LITERAL_FN}-escaped`,
					).toContain(`${REGEX_LITERAL_FN}(f_unaccent(`);
					expect(
						unescapedNormalizations(operand),
						`${file} / ${q}: operand ${operand} normalizes OUTSIDE the escape`,
					).not.toContain('f_unaccent(');
					const tokens = operandTokens(operand);
					expect(tokens.length, `${file} / ${q}: operand binds no token`).toBe(1);
					// and the bound value is the curator's term, RAW — a second,
					// TypeScript-side escape would double-escape it in SQL.
					const value = String(built.tokenValues[tokens[0] as string]);
					expect(value, `${file} / ${q}: ${tokens[0]}`).toBe(
						q.replaceAll('*', '').replace(/^(!=|-)/, ''),
					);
					operandsChecked += 1;
				}
			}
		}
		// Floor: 20 shapes above, each with at least one pattern operand.
		expect(operandsChecked).toBeGreaterThan(17);
	});

	test('the store PRE-FILTER escapes its LIKE operand the same way, on the same side', () => {
		const built = asFragment(
			buildStringFragment(EXPANDING_TERM, null, false, context({ searchStoreCovered: true })),
		);
		expect(built.sentence).toContain('matrix_string_search sv');
		expect(built.sentence).toContain(`LIKE '%' || ${LIKE_LITERAL_FN}(lower(f_unaccent(_Q0_)))`);
		// raw on the wire, escaped in SQL — the superset and the exact predicate
		// must agree for a term unaccent expands into a LIKE wildcard.
		expect(built.tokenValues._Q0_).toBe(EXPANDING_TERM);
	});

	test('POSITIVE CONTROL: the pre-fix operand shape IS reported', () => {
		// Exactly what the builders emitted before this correction: normalization
		// with no escape around it. If the detector cannot see this, the census
		// above proves nothing.
		const sentence = "f_unaccent(elem->>'value') ~* f_unaccent(_Q1_)";
		const [operand] = patternOperands(sentence);
		expect(operand).toBe('f_unaccent(_Q1_)');
		expect(operand).not.toContain(`${REGEX_LITERAL_FN}(`);
		expect(unescapedNormalizations(operand as string)).toContain('f_unaccent(');
		// and the TypeScript-escape era's bound value is reported as NOT raw
		expect('Denarius \\[sic\\]').not.toBe(TERM);
	});

	test('BOUNDARY: the equality shapes keep the RAW term and the PLAIN normalization', () => {
		for (const q of [`==${TERM}`, `=${TERM}`, `'${TERM}'`]) {
			const built = asFragment(buildStringFragment(q, null, false, context()));
			expect(built.sentence).not.toContain('~*');
			// '=' ignores letter case (WC-014 amend); '==' and the quoted literal do not
			expect(built.sentence).toContain(
				q.startsWith('=') && !q.startsWith('==')
					? "lower(f_unaccent(elem->>'value')) = lower(f_unaccent(_Q1_))"
					: "f_unaccent(elem->>'value') = f_unaccent(_Q1_)",
			);
			expect(built.sentence).not.toContain(REGEX_LITERAL_FN);
			expect(built.tokenValues._Q1_).toBe(TERM);
		}
		// json + iri equality twins
		expect(
			asFragment(buildJsonFragment(`==${TERM}`, null, context({ column: 'misc' }))).tokenValues
				._Q1_,
		).toBe(TERM);
		expect(
			asFragment(buildIriFragment(`==${TERM}`, null, context({ column: 'iri' }))).tokenValues._Q1_,
		).toBe(TERM);
	});

	test('anchors compose OUTSIDE the escaped operand', () => {
		const begins = asFragment(buildStringFragment(`${TERM}*`, null, false, context()));
		expect(begins.sentence).toContain(`~* ('^' || ${REGEX_LITERAL_FN}(f_unaccent(_Q1_)))`);
		const ends = asFragment(buildStringFragment(`*${TERM}`, null, false, context()));
		expect(ends.sentence).toContain(`~* (${REGEX_LITERAL_FN}(f_unaccent(_Q1_)) || '$')`);
	});
});

describe('the escape functions reach every install', () => {
	test('both are DECLARED, idempotent, and escape the whole declared class', () => {
		const names = declaredFunctions.map((entry) => entry.name);
		// Floor: the declaration list is non-trivial (f_unaccent and the sync
		// functions live here too) — an empty read would pass every leg below.
		expect(declaredFunctions.length).toBeGreaterThan(5);
		for (const fn of [REGEX_LITERAL_FN, LIKE_LITERAL_FN]) {
			expect(names, `${fn} is emitted but not declared`).toContain(fn);
			const entry = declaredFunctions.find((candidate) => candidate.name === fn) as FunctionEntry;
			expect(entry.add).toContain('CREATE OR REPLACE FUNCTION');
			expect(entry.add).toContain('IMMUTABLE');
		}
		// The regex escaper's own class must EQUAL the class the engine declares:
		// a character REGEX_META names but the SQL function does not escape is a
		// hole exactly where the corpus census looks, and one the function escapes
		// but the class does not name would silently corrupt an ordinary term.
		// The class is PARSED out of the declared body, never spelled twice.
		const body = (
			declaredFunctions.find((entry) => entry.name === REGEX_LITERAL_FN) as FunctionEntry
		).add;
		expect(sqlEscapedClass(body).sort()).toEqual([...META_CHARS].sort());
	});

	test('the BOOT MIGRATION carries both declared bodies verbatim', () => {
		// db_pg_definitions.json only reaches an install when an operator presses
		// "rebuild functions". The numbered migration is what a boot applies — and
		// without these functions EVERY contains search fails outright, so this is
		// not an optimisation but the difference between a search and an error.
		expect(migrationFileNames().length).toBeGreaterThan(5);
		const allSql = migrationsSql();
		for (const fn of [REGEX_LITERAL_FN, LIKE_LITERAL_FN]) {
			const entry = declaredFunctions.find((candidate) => candidate.name === fn) as FunctionEntry;
			expect(allSql, `${fn} is declared but no migration creates it`).toContain(entry.add.trim());
		}
	});
});
