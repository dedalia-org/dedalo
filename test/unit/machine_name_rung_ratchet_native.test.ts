/**
 * G6 — THE LEGACY MACHINE-NAME RUNGS MAY ONLY SHRINK
 * (WC-2026-11-04-ontology-machine-names, plan §3 / §9 P6 / §10 G6). The parser's
 * transition rungs (src/core/ontology/machine_name.ts — `legacy_lang`,
 * `single_value`, `derived_flag`; plus the reader bridges `legacy_model_term`
 * and `underived_row`) are the P1 → P4 bridge (owner decision D15): they let new
 * code read pre-ontology43 data. P6 deletes them, which needs every repo source
 * converted. This gate makes that a ratchet, measured on the suite database's
 * installed ontology (the vendored release + seed + repo test fixtures) through
 * `inspectOntology`, one tld at a time:
 *
 *  1. THE RUNG VOCABULARY IS CLOSED: the tally carries exactly the three parser
 *     rungs, and the code emits exactly the two reader-bridge counters. A new rung
 *     is a new bridge — it is added HERE, deliberately, or it is red.
 *  2. `legacy_lang`: the set of tlds that still name a node from ontology5's
 *     lg-spa item is banked in LEGACY_LANG_TLDS — shrink-only; a banked tld that
 *     no longer uses the rung is red too (lower the bank in the same change).
 *  3. `single_value`: banked EMPTY — a repo source whose name lives only in a
 *     non-Spanish label is a new legacy shape, never accepted.
 *  4. `derived_flag`: the release defines ontology44 since 7.0 (2026-11-07), so a
 *     node CAN state its flag; the set of tlds where some node still derives it is
 *     banked in DERIVED_FLAG_TLDS — shrink-only, like (2).
 *  5. THE READER BRIDGES ARE IDLE: no dd_ontology row is un-derived
 *     (`use_machine_name` NULL — what `underived_row` and `legacy_model_term`
 *     bridge), and no installed source carries a machine-name defect.
 *
 * Scratch `zz*` tlds are excluded. Read-only; needs the suite DB.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sql } from '../../src/core/db/postgres.ts';
import { inspectOntology, type OntologyState } from '../../src/core/ontology/ontology_state.ts';
import { getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { engineSourceFiles } from '../helpers/engine_source_corpus.ts';

/**
 * tlds whose nodes still take their name from ontology5 lg-spa. Measured 2026-11-04 as
 * dd/hierarchy/oh/rsc/test; the 7.0 release (2026-11-07) converted hierarchy, oh and rsc.
 */
const LEGACY_LANG_TLDS: readonly string[] = ['dd', 'test'];

/**
 * tlds where some node still DERIVES its flag (no ontology44 stated) — banked on the
 * 7.0 release's arrival (2026-11-07): 4 dd nodes, and the suite's own repo-owned `test*`
 * fixtures, none converted yet. Shrink-only; a banked tld that no longer derives is red.
 */
const DERIVED_FLAG_TLDS: readonly string[] = [
	'dd',
	'test',
	'testaa',
	'testactivity',
	'testcatalogs',
	'testcoincatalog',
	'testcont',
	'testcult',
	'testculture',
	'testeventype',
	'testgraves',
	'testgrup',
	'testheritagecatalog',
	'testicon',
	'testimmovable',
	'testmint',
	'testperi',
	'testplace',
	'testrespathology',
	'testsccmk',
	'testscell',
	'testsclat',
	'testscsym',
	'testsctxr',
	'testscxibm',
	'testscxibo',
	'testscxpu',
	'testseri',
	'testtema',
	'testterr',
	'testtypology',
	'testuncertainty',
	'testunit',
	'testweb',
];

/** The parser rungs (OntologyState.machineNameLegacyRungs keys). */
const PARSER_RUNGS: readonly string[] = ['derived_flag', 'legacy_lang', 'single_value'];

/** The reader-bridge counters (`ontology_machine_name_rung_<name>` literals in src/). */
const READER_BRIDGES: readonly string[] = ['legacy_model_term', 'underived_row'];

const tlds = (
	(await sql.unsafe(`SELECT DISTINCT tld FROM dd_ontology WHERE tld !~ '^zz' ORDER BY 1`)) as {
		tld: string;
	}[]
).map((row) => row.tld);

const states = new Map<string, OntologyState>();
for (const tld of tlds) states.set(tld, await inspectOntology(tld));

const armed =
	(await getModelByTipo('ontology43')) !== null && (await getModelByTipo('ontology44')) !== null;

/** The tlds whose tally uses `rung` at least once. */
function tldsUsing(rung: string): string[] {
	return [...states.entries()]
		.filter(
			([, state]) => ((state.machineNameLegacyRungs as Record<string, number>)[rung] ?? 0) > 0,
		)
		.map(([tld]) => tld)
		.sort();
}

describe('legacy machine-name rungs ratchet (G6)', () => {
	test('floor: the suite carries the release (tlds with parsed nodes)', () => {
		expect(tlds).toContain('dd');
		expect(states.get('dd')?.matrixNodes ?? 0).toBeGreaterThan(1000);
	});

	test('the rung vocabulary is closed: three parser rungs, two reader bridges', () => {
		for (const state of states.values()) {
			expect(Object.keys(state.machineNameLegacyRungs).sort()).toEqual([...PARSER_RUNGS]);
		}
		const emitted = new Set<string>();
		// The engine corpus is the registered shared lister's (census_derivation_tripwire);
		// its floor: the engine is well over a thousand files.
		const files = engineSourceFiles();
		expect(files.length).toBeGreaterThan(1000);
		for (const file of files) {
			for (const match of readFileSync(file, 'utf8').matchAll(
				/ontology_machine_name_rung_([a-z_]+)/g,
			)) {
				emitted.add(match[1] as string);
			}
		}
		expect([...emitted].sort()).toEqual([...READER_BRIDGES]);
	});

	test('legacy_lang: only the banked tlds use it (shrink-only; a stale entry is red)', () => {
		expect(tldsUsing('legacy_lang')).toEqual([...LEGACY_LANG_TLDS]);
	});

	test('single_value: no installed source names a node from a lone non-Spanish label', () => {
		expect(tldsUsing('single_value')).toEqual([]);
	});

	test('derived_flag: the release defines ontology44, and only the banked tlds still derive it (shrink-only)', () => {
		// Armed: a node CAN state its flag, so a derived one is legacy debt, banked like (2).
		expect(armed, 'the suite release defines ontology43/44').toBe(true);
		expect(tldsUsing('derived_flag')).toEqual([...DERIVED_FLAG_TLDS]);
	});

	test('the reader bridges are idle: no un-derived row, no machine-name defect', async () => {
		const underived = (await sql.unsafe(
			`SELECT count(*)::int AS n FROM dd_ontology WHERE use_machine_name IS NULL AND tld !~ '^zz'`,
		)) as { n: number }[];
		expect(underived[0]?.n).toBe(0);
		const defects = [...states.values()].flatMap((state) =>
			state.machineNameDefects.map((defect) => `${defect.source}:${defect.kind}`),
		);
		expect(defects).toEqual([]);
	});
});
