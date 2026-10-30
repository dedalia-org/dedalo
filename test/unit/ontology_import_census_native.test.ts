/**
 * U-14 — the ontology IMPORT CENSUS (report only — D-6: report, never refuse).
 *
 * `updateOntology` (src/core/ontology/ontology_update.ts) measures, after
 * staging and before Phase B/C, what each staged package is about to REMOVE
 * from `<tld>0` and what it RE-MODELS (same tipo, another ontology6 model), and
 * for a dropped/re-modelled SECTION how many records are stored under it. The
 * result rides the response as `census` and one message line per TLD with
 * findings; the import itself proceeds unchanged.
 *
 * Driven through the REAL orchestrator (deps seam: catalog, manifest, io dirs,
 * active TLDs — the shell gate's pattern) against a local fixture "master".
 * Scratch: tld `zzci` (section zzci0) + two records of section `zzci1` in
 * matrix_test; swept beforeEach + afterAll, zero residue asserted.
 * Models are CORE nodes the suite DB always holds: dd6 = section,
 * dd9 = component_input_text, dd10 = component_text_area.
 *
 * Mutations: drop the census call → case 1 red (no `census`); compare by
 * locator presence only (no model diff) → `remodelled` empty, red; skip the
 * record count → `records` absent, red; refuse on findings → `ok` false, red.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { MATRIX_COPY_COLUMNS } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { updateOntology } from '../../src/core/ontology/ontology_update.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { manifestSourceDeps } from '../helpers/ontology_manifest_fixture.ts';

const TLD = 'zzci';
const SECTION = 'zzci0';
const LIKE = 'zzci%';
/** Records stored under the section node zzci1 (the census must count them). */
const RECORD_SECTION = 'zzci1';

const MODEL = { section: 6, inputText: 9, textArea: 10 } as const;

const tempRoots: string[] = [];

interface Node {
	id: number;
	model: number;
	term: string;
}

function columnsOf(node: Node): { data: string; relation: string; string: string } {
	return {
		data: JSON.stringify({ section_id: node.id, section_tipo: SECTION }),
		relation: JSON.stringify({
			ontology6: [
				{
					id: 1,
					type: 'dd151',
					section_id: node.model,
					section_tipo: 'dd0',
					from_component_tipo: 'ontology6',
				},
			],
			ontology15: [
				{
					id: 1,
					type: 'dd151',
					section_id: '0',
					section_tipo: SECTION,
					from_component_tipo: 'ontology15',
				},
			],
		}),
		string: JSON.stringify({
			ontology5: [{ id: 1, lang: 'lg-spa', value: node.term }],
			ontology7: [{ id: 1, lang: 'lg-nolan', value: TLD }],
		}),
	};
}

/** The package: the nodes as the master's COPY dump carries them. */
function packageOf(nodes: readonly Node[]): Buffer {
	const lines = nodes.map((node) => {
		const cols = columnsOf(node);
		return [
			String(node.id),
			SECTION,
			cols.data,
			cols.relation,
			cols.string,
			...Array.from({ length: MATRIX_COPY_COLUMNS.length - 5 }, () => '\\N'),
		].join('\t');
	});
	return Buffer.from(`${lines.join('\n')}\n`, 'utf8');
}

/** The CURRENT rows of zzci0 (what this installation holds before the update). */
async function seedCurrent(nodes: readonly Node[]): Promise<void> {
	for (const node of nodes) {
		const cols = columnsOf(node);
		await sql`INSERT INTO matrix_ontology (section_id, section_tipo, data, relation, string)
		          VALUES (${node.id}, ${SECTION}, ${cols.data}::text::jsonb,
		                  ${cols.relation}::text::jsonb, ${cols.string}::text::jsonb)`;
	}
	await clearOntologyDerivedCaches();
}

async function seedRecords(count: number): Promise<void> {
	for (let id = 1; id <= count; id++) {
		await sql`INSERT INTO matrix_test (section_id, section_tipo, data)
		          VALUES (${id}, ${RECORD_SECTION},
		                  ${JSON.stringify({ section_id: id, section_tipo: RECORD_SECTION })}::text::jsonb)`;
	}
}

async function sweep(): Promise<void> {
	await sql`DELETE FROM matrix_ontology WHERE section_tipo LIKE ${LIKE}`;
	await sql`DELETE FROM dd_ontology WHERE tipo LIKE ${LIKE}`;
	await sql`DELETE FROM matrix_counter WHERE tipo LIKE ${LIKE}`;
	await sql`DELETE FROM matrix_ontology_main WHERE string->'hierarchy6' @> '[{"value":"zzci"}]'::jsonb`;
	await sql`DELETE FROM matrix_time_machine WHERE section_tipo LIKE ${LIKE}`;
	await sql`DELETE FROM matrix_test WHERE section_tipo = ${RECORD_SECTION}`;
	await clearOntologyDerivedCaches();
}

async function residue(): Promise<number> {
	const rows = (await sql`
		SELECT (SELECT count(*) FROM matrix_ontology WHERE section_tipo LIKE ${LIKE})
		     + (SELECT count(*) FROM dd_ontology WHERE tipo LIKE ${LIKE})
		     + (SELECT count(*) FROM matrix_test WHERE section_tipo = ${RECORD_SECTION})
		     + (SELECT count(*) FROM matrix_ontology_main
		         WHERE string->'hierarchy6' @> '[{"value":"zzci"}]'::jsonb) AS n`) as unknown as {
		n: number;
	}[];
	return Number(rows[0]?.n);
}

/** One full update of `zzci` serving `nodes` from a local fixture master. */
async function updateWith(nodes: readonly Node[]) {
	const root = mkdtempSync(join(tmpdir(), 'zzci_census_'));
	tempRoots.push(root);
	const ioBaseDir = join(root, 'io');
	mkdirSync(ioBaseDir, { recursive: true });
	const body = gzipSync(packageOf(nodes));
	const server = Bun.serve({
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname.endsWith('/zzci.copy.gz')
				? new Response(body)
				: new Response('nope', { status: 404 }),
	});
	const origin = `http://localhost:${server.port}`;
	try {
		return await updateOntology(
			{
				server: { name: 'zzci master', url: `${origin}/api/`, code: 'zzcimaster' },
				files: [{ tld: TLD, url: `${origin}/zzci.copy.gz` }],
			},
			-1,
			{
				catalog: {
					servers: [{ code: 'zzcimaster', url: `${origin}/api/` }],
					isOntologyServer: false,
				},
				...manifestSourceDeps([{ tld: TLD, url: `${origin}/zzci.copy.gz` }]),
				ioBaseDir,
				changesDir: join(root, 'changes'),
				activeTlds: [TLD],
			},
		);
	} finally {
		server.stop(true);
	}
}

async function sectionIds(): Promise<number[]> {
	const rows = (await sql`SELECT section_id FROM matrix_ontology WHERE section_tipo = ${SECTION}
	                        ORDER BY section_id`) as unknown as { section_id: number }[];
	return rows.map((row) => Number(row.section_id));
}

beforeEach(async () => {
	await assertTestDatabase('ontology_import_census_native');
	await sweep();
});

afterAll(async () => {
	await sweep();
	expect(await residue()).toBe(0);
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('U-14 import census', () => {
	test('a package that drops a section node and re-models another is REPORTED, and the import proceeds', async () => {
		await seedCurrent([
			{ id: 1, model: MODEL.section, term: 'dropped section' },
			{ id: 2, model: MODEL.inputText, term: 're-modelled' },
			{ id: 3, model: MODEL.inputText, term: 'unchanged' },
		]);
		await seedRecords(2);
		expect(await sectionIds()).toEqual([1, 2, 3]);

		const out = await updateWith([
			{ id: 2, model: MODEL.textArea, term: 're-modelled' },
			{ id: 3, model: MODEL.inputText, term: 'unchanged' },
		]);

		// report, never refuse: the update landed
		expect(out.errors).toEqual([]);
		expect(out.ok).toBe(true);
		expect(await sectionIds()).toEqual([2, 3]);

		// floor: the census READ the package (one entry for the one staged tld)
		expect(out.census).toHaveLength(1);
		expect(out.census).toEqual([
			{
				tld: TLD,
				removed: [{ tipo: 'zzci1', model: 'section', records: 2 }],
				remodelled: [{ tipo: 'zzci2', from: 'component_input_text', to: 'component_text_area' }],
			},
		]);
		expect(out.msg).toContain(
			'zzci: import census — 1 node(s) removed (zzci1); 1 node(s) re-modelled (zzci2 component_input_text → component_text_area); 2 record(s) are stored under the affected section(s) (report only — the import proceeds)',
		);
		// the census only READ: the records under the dropped section are untouched
		const kept = (await sql`SELECT count(*)::int AS n FROM matrix_test
		                        WHERE section_tipo = ${RECORD_SECTION}`) as unknown as { n: number }[];
		expect(Number(kept[0]?.n)).toBe(2);
	}, 120_000);

	test('a package that drops and re-models nothing: an empty census entry, no census line', async () => {
		const nodes = [
			{ id: 1, model: MODEL.inputText, term: 'a' },
			{ id: 2, model: MODEL.textArea, term: 'b' },
		];
		await seedCurrent(nodes);
		// a node the package ADDS is not a finding either
		const out = await updateWith([...nodes, { id: 3, model: MODEL.section, term: 'new' }]);

		expect(out.ok).toBe(true);
		expect(await sectionIds()).toEqual([1, 2, 3]);
		expect(out.census).toEqual([{ tld: TLD, removed: [], remodelled: [] }]);
		expect(out.msg).not.toContain('import census');
	}, 120_000);
});
