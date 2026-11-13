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
 *  6. THE SUITE ONTOLOGY IS A FIXED POINT OF THE BOOT RECONCILE (T1-P05): the dry
 *     census of `ontology_machine_names` finds no class-L or class-C record, and its
 *     class-S records are exactly STRAY_SOURCES — so no scheduler-enabled server booting
 *     on the suite DB can rewrite the fixture under the gates (it did, 2026-11-08: the
 *     banks flapped with suite order).
 *
 * Scratch `zz*` tlds are excluded. Read-only; needs the suite DB.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sql } from '../../src/core/db/postgres.ts';
import { censusMachineNames } from '../../src/core/ontology/machine_name_reconcile.ts';
import { inspectOntology, type OntologyState } from '../../src/core/ontology/ontology_state.ts';
import { getModelByTipo } from '../../src/core/ontology/resolver.ts';
import { engineSourceFiles } from '../helpers/engine_source_corpus.ts';

/**
 * tlds whose nodes still take their name from ontology5 lg-spa. Measured 2026-11-04 as
 * dd/hierarchy/oh/rsc/test; the 7.0 release (2026-11-07) converted hierarchy, oh and rsc.
 */
const LEGACY_LANG_TLDS: readonly string[] = ['dd', 'test'];

/**
 * tlds where some node still DERIVES its flag (no ontology44 stated). Banked on the 7.0
 * release (2026-11-07) as dd + every repo-owned `test*` fixture tld; RE-BANKED 2026-11-13
 * (T1-P05): the suite's test-TLD materializer now runs the package import rewrite (class
 * L) like every import door, so the fixture states its flags. What stays derived is the
 * class-S strays no door auto-applies (STRAY_SOURCES below): 4 dd release nodes and 9
 * `test` clone twins. Shrink-only; a banked tld that no longer derives is red.
 */
const DERIVED_FLAG_TLDS: readonly string[] = ['dd', 'test'];

/**
 * The class-S records (strays: the name moves, but another lang holds a DIFFERENT label)
 * the census finds on the suite ontology — root's adjudication (D3), never auto-applied,
 * so they are the whole residue a boot reconcile could still be offered. Measured
 * 2026-11-13 (T1-P05). Shrink-only, like the banks: a new stray is red, a fixed one too.
 */
const STRAY_SOURCES: readonly string[] = [
	'dd1200',
	'dd558',
	'dd772',
	'dd955',
	'test6537',
	'test6548',
	'test6569',
	'test6571',
	'test6575',
	'test6579',
	'test6580',
	'test6584',
	'test6585',
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
		// Per tld: a banked one derives on at least one node, never on more than it parses;
		// an unbanked one derives on none.
		for (const [tld, state] of states) {
			const derived = state.machineNameLegacyRungs.derived_flag;
			if (DERIVED_FLAG_TLDS.includes(tld)) {
				expect(derived, tld).toBeGreaterThan(0);
				expect(derived, tld).toBeLessThanOrEqual(state.matrixNodes);
			} else expect(derived, tld).toBe(0);
		}
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

	test('the suite ontology is a FIXED POINT of the boot reconcile: no L, no C, S = the banked strays', async () => {
		const census = await censusMachineNames(tlds);
		// Floor: the walk read the whole release + fixture (well over ten thousand records).
		expect(census.scanned).toBeGreaterThan(10_000);
		const lossless = census.units
			.filter((unit) => unit.conversion.class === 'L')
			.map((unit) => `${unit.tipo}:${unit.conversion.kind}`);
		expect(lossless.slice(0, 20), `${lossless.length} class-L record(s) left`).toEqual([]);
		expect(census.classes.C).toBe(0);
		const strays = census.units
			.filter((unit) => unit.conversion.class === 'S')
			.map((unit) => unit.tipo)
			.sort();
		expect(strays).toEqual([...STRAY_SOURCES]);
	});
});
