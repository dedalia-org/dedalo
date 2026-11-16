/**
 * SINGLE-SOURCE TRIPWIRE for the flat/human date value (DEC-12: an invariant
 * you state gets a mechanical gate, or you delete the invariant).
 *
 * THE INVARIANT, stated once:
 *
 *   The engine has exactly ONE implementation of "a stored component_date item
 *   rendered as a human string" — `dateItemToValue` in
 *   src/core/components/component_date/date_value.ts, the port of the frozen
 *   PHP `component_date::data_item_to_value()`. Every surface that renders such
 *   an item calls it. Nothing hand-rolls a second one.
 *
 * WHY IT EXISTS. The 2026-08 oh1 beta audit (§5.6) found a second, divergent
 * copy inside the relation-list / tool_export cell resolver: `d-m-Y` joined
 * with '-', no `date_mode` dispatch, and the MONTH silently dropped whenever
 * the day was absent. Partial dates are the norm in heritage cataloguing, so
 * live rsc170/rsc26 "Dating" records were losing their month in the Referencias
 * panel and in every export. A copy is only ever one refactor away from
 * drifting again, so the copy is not merely deleted — its RETURN is gated.
 *
 * HOW IT IS GATED — two independent detectors, one reasoned census:
 *
 *   D1 `date_mode` dispatch. Only a HUMAN date renderer (or a search/diffusion
 *      path that resolves the same ontology property) reads `date_mode`. Any
 *      src file that reads it must either import the canonical module or carry
 *      a census entry saying what it does instead.
 *
 *   D2 date-part assembly. Any src file that interpolates two adjacent dd_date
 *      fields (year/month/day/hour/minute/second) into one string is building a
 *      date by hand. Same rule: canonical, or censused with a reason.
 *
 * NON-VACUITY. D2 flags the DELETED duplicate (verified: the pre-fix
 * `${pad(date.day)}-${pad(date.month)}-${date.year}` matches), and every census
 * entry's path must exist, so a rename cannot quietly empty the gate.
 *
 * IF YOU TRIP IT: the fix is almost always to import `dateItemToValue`. Add a
 * census entry ONLY for a formatter that is genuinely a different contract —
 * a machine timestamp (SQL/ISO), a search bound, or a distinct PHP method —
 * and write the reason next to it. Never widen a `role` silently.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const CANONICAL = 'src/core/components/component_date/date_value.ts';

/** Surfaces that render a stored component_date item for a HUMAN to read. */
const DISPLAY_CONSUMERS = [
	'src/core/resolve/relation_list.ts', // Referencias panel + tool_export cells
	'src/core/section/indexation_grid.ts', // thesaurus indexation grid atoms
	'src/ai/rag/role_reader.ts', // the characterizer's date-role label
] as const;

interface CensusEntry {
	file: string;
	role: 'search' | 'machine-timestamp' | 'distinct-php-method' | 'documentation';
	why: string;
}

/**
 * Files a detector flags that are NOT the human date value. Each is a
 * different contract, named and justified — not an escape hatch.
 */
const CENSUS: readonly CensusEntry[] = [
	{
		file: 'src/core/search/conform.ts',
		role: 'search',
		why: 'resolves date_mode to shape the SQO (PHP get_date_search_context), never renders a value',
	},
	{
		file: 'src/core/search/builders/builder_date.ts',
		role: 'search',
		why: 'PHP dispatch_date_mode_sql: date_mode picks the SQL sentence; its Y-m-d strings are query BOUNDS',
	},
	{
		file: 'src/core/search/builders/types.ts',
		role: 'documentation',
		why: 'the builder input type documents the date_mode leaf; no code path renders anything',
	},
	{
		file: 'src/core/identify/criteria.ts',
		role: 'documentation',
		why: 'prose only: notes which date_mode handlers the criterion resolver relies on',
	},
	{
		file: 'src/core/components/types.ts',
		role: 'documentation',
		why: 'the flatValue family doc names date_mode to point readers at the canonical formatter; it is a type file with no runtime path',
	},
	{
		file: 'src/diffusion/parsers/parser_date.ts',
		role: 'distinct-php-method',
		why: 'PHP component_date::get_diffusion_value — the PUBLISHED machine timestamp ("Y-m-d H:i:s"), a different method with a different contract from data_item_to_value',
	},
	{
		file: 'src/core/db/db_timestamp.ts',
		role: 'machine-timestamp',
		why: 'the ONE TM/data timestamp writer; a Postgres timestamp, not a component value',
	},
	{
		file: 'src/core/ontology/data_io.ts',
		role: 'machine-timestamp',
		why: 'ISO-8601 serialization of an export envelope date',
	},
	{
		file: 'src/core/media/files_info.ts',
		role: 'machine-timestamp',
		why: 'a file mtime rendered for files_info; never a component_date item',
	},
	{
		file: 'src/core/tools/import_csv_execute.ts',
		role: 'machine-timestamp',
		why: 'builds the SQL timestamp literal an import row is written with',
	},
	{
		file: 'src/core/section/record/record_metadata.ts',
		role: 'machine-timestamp',
		why: 'renders a dd199 `start` as the `data.created_date` SQL timestamp literal (the record-header twin the CSV importer writes and the bulk revert re-derives); never a component_date item',
	},
	{
		file: 'src/core/ontology/property_census.ts',
		role: 'documentation',
		why: 'a REGISTRY of ontology property NAMES: `date_mode` appears as a string in the honoured-key list, and nothing here reads or renders a date',
	},
	{
		file: 'src/core/geoip/download.ts',
		role: 'machine-timestamp',
		why: 'interpolates year/month into a DOWNLOAD URL, not into a date value',
	},
	{
		file: 'src/diffusion/resolve/rdf_graph_ir.ts',
		role: 'distinct-php-method',
		why: 'the CANONICAL XSD lexical form of an rdf typed literal (owner C12, WC-2026-11-13-rdf-canonical-xsd-lexical): zero-pads the year/month/day fields of a value the ontology already typed gYear/date/dateTime; a published machine form, never the human flat date value',
	},
];

const CENSUS_FILES = new Set(CENSUS.map((entry) => entry.file));

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

function walk(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) walk(path, acc);
		else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) acc.push(path);
	}
	return acc;
}

const FILES: { path: string; source: string }[] = walk(join(ROOT, 'src')).map((absolute) => ({
	path: relative(ROOT, absolute),
	source: readFileSync(absolute, 'utf8'),
}));

/** D1: reads the ontology `date_mode` property (not `force_update_mode` &c). */
const DATE_MODE = /(?<![A-Za-z0-9_])date_mode/;

/**
 * D2: two adjacent dd_date fields interpolated into one string — i.e. a date
 * assembled by hand. Matches the DELETED duplicate
 * (`${pad(date.day)}-${pad(date.month)}-${date.year}`) and the canonical
 * module's own `${padYear(part.year)}${sep}${pad2(part.month)}`.
 */
const DATE_PART_ASSEMBLY =
	/\$\{[^{}]*\b(?:year|month|day|hour|minute|second)\b[^{}]*\}[^`$]{0,4}\$\{/i;

const flaggedBy = (detector: RegExp): string[] =>
	FILES.filter((file) => detector.test(file.source)).map((file) => file.path);

// ---------------------------------------------------------------------------

describe('the flat date value has exactly one implementation', () => {
	test('the canonical module exists and is where the formatter lives', () => {
		const canonical = FILES.find((file) => file.path === CANONICAL);
		expect(canonical, `${CANONICAL} is missing`).toBeDefined();
		expect(canonical?.source).toContain('export function dateItemToValue');
		// Both detectors must fire on it, or they are dead regexes and every
		// assertion below passes vacuously.
		expect(DATE_MODE.test(canonical?.source ?? '')).toBe(true);
		expect(DATE_PART_ASSEMBLY.test(canonical?.source ?? '')).toBe(true);
	});

	test('nothing else in src/ defines a dateItemToValue', () => {
		const definers = FILES.filter((file) => /function dateItemToValue/.test(file.source)).map(
			(file) => file.path,
		);
		expect(definers).toEqual([CANONICAL]);
	});

	test('every display surface imports it instead of rolling its own', () => {
		for (const consumer of DISPLAY_CONSUMERS) {
			const file = FILES.find((candidate) => candidate.path === consumer);
			expect(file, `display consumer ${consumer} is missing`).toBeDefined();
			expect(
				file?.source.includes('component_date/date_value.ts'),
				`${consumer} no longer imports the canonical date formatter`,
			).toBe(true);
			expect(
				DATE_PART_ASSEMBLY.test(file?.source ?? ''),
				`${consumer} assembles a date by hand again — that is the duplicate coming back`,
			).toBe(false);
		}
	});

	test('D1: every date_mode reader is the canonical module, a consumer, or censused', () => {
		const strays = flaggedBy(DATE_MODE).filter(
			(path) =>
				path !== CANONICAL &&
				!DISPLAY_CONSUMERS.includes(path as (typeof DISPLAY_CONSUMERS)[number]) &&
				!CENSUS_FILES.has(path),
		);
		expect(strays).toEqual([]);
	});

	test('D2: every hand-assembled date is the canonical module or censused', () => {
		const strays = flaggedBy(DATE_PART_ASSEMBLY).filter(
			(path) => path !== CANONICAL && !CENSUS_FILES.has(path),
		);
		expect(strays).toEqual([]);
	});

	test('the census names only real files, each with a reason', () => {
		const known = new Set(FILES.map((file) => file.path));
		for (const entry of CENSUS) {
			expect(known.has(entry.file), `census names a missing file: ${entry.file}`).toBe(true);
			expect(entry.why.length, `census entry ${entry.file} has no reason`).toBeGreaterThan(20);
		}
		// A census that grew to cover everything would silently disarm the gate.
		expect(CENSUS.length).toBeLessThanOrEqual(14);
	});

	test('the d-m-Y shape the audit found can never come back', () => {
		// The exact regression: day, month, year in that order glued by '-'.
		const dmy = /\$\{[^{}]*\bday\b[^{}]*\}-\$\{[^{}]*\bmonth\b[^{}]*\}-\$\{[^{}]*\byear\b[^{}]*\}/i;
		expect(FILES.filter((file) => dmy.test(file.source)).map((file) => file.path)).toEqual([]);
	});
});
