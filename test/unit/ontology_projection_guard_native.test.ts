/**
 * ONT-2 — the dd_ontology PROJECTION PRIMITIVE refuses to write outside the namespace the
 * record's own address names. TS-native write-path contract (audit 2026-09-26, Step 5).
 *
 * Addressing rule (INV-A): a governed record `<tld>0/<id>` may only ever project the node
 * `<tld><id>`. The tipo is `buildTipo(requiredOntologyTld(sectionTipo), sectionId)` — never
 * what the record's `ontology7` happens to say. Before this gate `insertDdOntologyRecord`
 * upserted whatever the parser produced, so:
 *   (a) a misfiled `zzgua0/5` declaring `ontology7='zzgub'` OVERWROTE the canonical `zzgub5`
 *       through `setRecordsInDdOntology` / `tool_ontology` edit mode;
 *   (b) a record of a section no tld governs (`test3`, `ontology1`) carrying an `ontology7`
 *       was projected as a node of that tld;
 *   (c) list mode resolved the client's SQO over ANY section and re-attributed the matched
 *       ids to `options.section_tipo` (`sqo.section_tipo=['zzgub0']` wrote `zzgua7` with the
 *       term of `zzgub0/7`... or of `zzgua0/7`, whichever exists).
 *
 * Pinned here (outcomes only): G2a the primitive, the driver and the handler refuse a foreign
 * record and leave the canonical row byte-identical; G2b a non-governed section is refused at
 * every door; G2c the SQO's section axis must be exactly `[section_tipo]` (the bare string
 * `section_tipo` is the same axis — accepted, and refused when it names another section), and
 * the list-mode SUCCESS path projects exactly the matched records, each at its own address;
 * G2e the server's
 * admission rule is a subset of the tool's declared dd1350 rule and excludes `localontology0`;
 * G2f the tolerated refusal is the foreign-namespace one BY CLASS (ForeignOntologyNodeRefused):
 * a grammar / constraint `ontology.invalid_node` from the write (forced — no parse reaches one
 * today) is fatal to setRecordsInDdOntology; G2d a `children_recursive` list sqo is REFUSED on
 * both routes, nothing written. With the axis pinned to `[section_tipo]` (G2c) every matched
 * row is a record of that section, so the ids are read under it — except that the search
 * layer's `children_recursive` merges descendant ids of ANY section into ONE section_id
 * IN-list the axis then scopes (`src/core/search/sql_assembler.ts` childrenRecursiveFilter):
 * it would hand this door a same-id record the caller never chose and lose the real
 * descendant. G2d's CONTROL pins that re-attribution in the assembler — when the assembler
 * returns descendants under their own sections, the control goes red and the refusal can be
 * replaced by per-section projection.
 *
 * Scratch: tlds `zzgua` (section zzgua0) + `zzgub` (zzgub0); one `test3` scratch record; one
 * `ontology1` row at id 942601. Swept before and after; zero residue asserted.
 */

import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ddOntology from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	insertDdOntologyRecord,
	setRecordsInDdOntology,
} from '../../src/core/ontology/ontology_write.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { ForeignOntologyNodeRefused } from '../../src/core/section_record/ontology_projection.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { toolOntologySetRecords } from '../../tools/tool_ontology/server/tool_ontology.ts';
import { refusalOf } from '../helpers/refusal.ts';
import { buildSearchSql } from '../helpers/search_sql.ts';

const OWN = 'zzgua';
const OTHER = 'zzgub';
const OWN_SECTION = `${OWN}0`;
const OTHER_SECTION = `${OTHER}0`;
const UNGOVERNED_ONTOLOGY_SECTION = 'ontology1';
const UNGOVERNED_ONTOLOGY_ID = 942601;

const DEVELOPER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const ctx = (options: Record<string, unknown>) =>
	({ principal: DEVELOPER, userId: DEVELOPER.userId, options }) as never;

let test3Scratch: number | null = null;

/** One matrix_ontology-shaped record (any table) declaring `declaredTld` and a term. */
async function seed(
	table: string,
	sectionTipo: string,
	sectionId: number,
	declaredTld: string,
	term: string,
): Promise<void> {
	await sql.unsafe(
		`INSERT INTO "${table}" (section_id, section_tipo, data, relation, string)
		 VALUES ($1, $2, $3::text::jsonb, '{}'::jsonb, $4::text::jsonb)`,
		[
			sectionId,
			sectionTipo,
			JSON.stringify({ section_id: sectionId, section_tipo: sectionTipo }),
			JSON.stringify({
				ontology7: [{ id: 1, lang: 'lg-nolan', value: declaredTld }],
				ontology5: [{ id: 1, lang: 'lg-spa', value: term }],
			}),
		],
	);
	await clearOntologyDerivedCaches();
}

/** A canonical, already-projected node (no source record needed for the guard). */
async function plantNode(tipo: string, tld: string, term: string): Promise<void> {
	await sql.unsafe(
		`INSERT INTO dd_ontology (tipo, tld, model, term, is_model, is_translatable, is_main)
		 VALUES ($1, $2, 'component_input_text', $3::text::jsonb, false, true, $4)`,
		[tipo, tld, JSON.stringify({ 'lg-spa': term }), tipo === `${tld}0`],
	);
	await clearOntologyDerivedCaches();
}

/** The whole stored row (id included) — "byte-identical" means this, not the term alone. */
async function rowOf(tipo: string): Promise<unknown> {
	const rows = (await sql.unsafe('SELECT to_jsonb(d) AS row FROM dd_ontology d WHERE tipo = $1', [
		tipo,
	])) as { row: unknown }[];
	return rows[0]?.row ?? null;
}

async function scratchTipos(): Promise<string[]> {
	const rows = (await sql.unsafe(
		'SELECT tipo FROM dd_ontology WHERE tld IN ($1, $2) OR tipo LIKE $3 OR tipo LIKE $4 ORDER BY tipo',
		[OWN, OTHER, `${OWN}%`, `${OTHER}%`],
	)) as { tipo: string }[];
	return rows.map((row) => row.tipo);
}

async function sweep(): Promise<void> {
	await assertTestDatabase('ontology_projection_guard_native');
	await sql.unsafe(
		'DELETE FROM dd_ontology WHERE tld IN ($1, $2) OR tipo LIKE $3 OR tipo LIKE $4',
		[OWN, OTHER, `${OWN}%`, `${OTHER}%`],
	);
	await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo IN ($1, $2)', [
		OWN_SECTION,
		OTHER_SECTION,
	]);
	await sql.unsafe('DELETE FROM matrix_ontology WHERE section_tipo = $1 AND section_id = $2', [
		UNGOVERNED_ONTOLOGY_SECTION,
		UNGOVERNED_ONTOLOGY_ID,
	]);
	await sql.unsafe(
		'DELETE FROM matrix_time_machine WHERE section_tipo IN ($1, $2) OR (section_tipo = $3 AND section_id = $4)',
		[OWN_SECTION, OTHER_SECTION, UNGOVERNED_ONTOLOGY_SECTION, UNGOVERNED_ONTOLOGY_ID],
	);
	if (test3Scratch !== null) {
		await sql.unsafe('DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2', [
			'test3',
			test3Scratch,
		]);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			['test3', test3Scratch],
		);
		test3Scratch = null;
	}
	await clearOntologyDerivedCaches();
}

beforeEach(sweep);
afterAll(async () => {
	await sweep();
	expect(await scratchTipos()).toEqual([]);
});

// ---------------------------------------------------------------------------
// G2a — a record that declares ANOTHER tld never writes into that tld
// ---------------------------------------------------------------------------

describe('G2a: a foreign record cannot overwrite the canonical node of another tld', () => {
	async function situation(): Promise<unknown> {
		await plantNode(`${OTHER}5`, OTHER, 'CANON');
		await seed('matrix_ontology', OWN_SECTION, 5, OTHER, 'FOREIGN');
		return rowOf(`${OTHER}5`);
	}

	test('insertDdOntologyRecord refuses with ontology.invalid_node; the canonical row is byte-identical', async () => {
		const canonical = await situation();
		expect(canonical).not.toBeNull();

		const refusal = await refusalOf(insertDdOntologyRecord(OWN_SECTION, 5));
		expect(refusal.code).toBe('ontology.invalid_node');
		expect(refusal.message).toContain(`declares tld '${OTHER}'`);
		expect(await rowOf(`${OTHER}5`)).toEqual(canonical);
		expect(await rowOf(`${OWN}5`)).toBeNull();
	});

	test('setRecordsInDdOntology answers ok:false with the per-record line, writes nothing', async () => {
		const canonical = await situation();

		const response = await setRecordsInDdOntology({
			sectionTipo: OWN_SECTION,
			sectionId: 5,
			userId: -1,
		});
		expect(response.ok).toBe(false);
		expect(response.errors.join(' | ')).toContain(`${OWN_SECTION}/5 declares tld '${OTHER}'`);
		expect(await rowOf(`${OTHER}5`)).toEqual(canonical);
	});

	test('tool_ontology edit mode fails the action; the canonical row is byte-identical', async () => {
		const canonical = await situation();

		const refusal = await refusalOf(
			toolOntologySetRecords(ctx({ section_tipo: OWN_SECTION, section_id: 5 })),
		);
		expect(refusal.code).toBe('tool.action_failed');
		expect(await rowOf(`${OTHER}5`)).toEqual(canonical);
	});
});

// ---------------------------------------------------------------------------
// G2f — only the NAMESPACE refusal is tolerated; any other invalid_node stays fatal
// ---------------------------------------------------------------------------

describe('G2f: the tolerated refusal is the foreign-namespace one, by class', () => {
	test('a foreign record is refused as ForeignOntologyNodeRefused (ontology.invalid_node)', async () => {
		await plantNode(`${OTHER}5`, OTHER, 'CANON');
		await seed('matrix_ontology', OWN_SECTION, 5, OTHER, 'FOREIGN');

		const refusal = await insertDdOntologyRecord(OWN_SECTION, 5).catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(ForeignOntologyNodeRefused);
		expect((refusal as DedaloError).code).toBe('ontology.invalid_node');
	});

	test('a grammar / constraint ontology.invalid_node from the write is FATAL to setRecords', async () => {
		await seed('matrix_ontology', OWN_SECTION, 6, OWN, 'own six');
		// The parser drops defective references and the address check precedes the write, so no
		// record reaches a grammar refusal today; the write door's own refusal is forced instead.
		const spy = spyOn(ddOntology, 'upsertDdOntologyNode').mockImplementation(async () => {
			throw new DedaloError('ontology.invalid_node', { message: 'G2f forced grammar refusal' });
		});
		try {
			const outcome = await setRecordsInDdOntology({
				sectionTipo: OWN_SECTION,
				sectionId: 6,
				userId: -1,
			}).catch((error: unknown) => error);
			expect(outcome).toBeInstanceOf(DedaloError);
			expect(outcome).not.toBeInstanceOf(ForeignOntologyNodeRefused);
			expect((outcome as DedaloError).message).toContain('G2f forced grammar refusal');
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		expect(await rowOf(`${OWN}6`)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// G2d — a children_recursive sqo cannot scope a projection
// ---------------------------------------------------------------------------

describe('G2d: list mode refuses a children_recursive sqo', () => {
	/** zzgua0/1 with a descendant zzgub0/8, and an unrelated zzgua0/8 (same id, never chosen). */
	/** A `<tld>0` root as createDdOntologyRootNode builds it: a virtual of ontology1 (children ontology14 / parent ontology15). */
	async function plantSectionRoot(tld: string): Promise<void> {
		await sql.unsafe(
			`INSERT INTO dd_ontology (tipo, tld, model, model_tipo, is_main, relations, term)
			 VALUES ($1, $2, 'section', 'dd6', true, $3::text::jsonb, $4::text::jsonb)`,
			[
				`${tld}0`,
				tld,
				JSON.stringify([{ tipo: 'ontology1' }, { tipo: 'dd1201' }]),
				JSON.stringify({ 'lg-spa': 'root' }),
			],
		);
		await clearOntologyDerivedCaches();
	}

	async function situation(): Promise<void> {
		await plantSectionRoot(OWN);
		await plantSectionRoot(OTHER);
		await seed('matrix_ontology', OWN_SECTION, 1, OWN, 'chosen');
		await seed('matrix_ontology', OWN_SECTION, 8, OWN, 'never chosen');
		await seed('matrix_ontology', OTHER_SECTION, 8, OTHER, 'descendant');
		await sql.unsafe(
			`UPDATE matrix_ontology SET relation = $3::text::jsonb
			  WHERE section_tipo = $1 AND section_id = $2`,
			[
				OTHER_SECTION,
				8,
				JSON.stringify({
					ontology15: [
						{
							type: 'dd47',
							section_id: 1,
							section_tipo: OWN_SECTION,
							from_component_tipo: 'ontology15',
						},
					],
				}),
			],
		);
		await clearOntologyDerivedCaches();
	}
	const recursiveSqo = (axis: string) => ({
		section_tipo: [axis],
		filter_by_locators: [{ section_tipo: axis, section_id: '1' }],
		children_recursive: true,
	});

	test('control: the assembler re-attributes the descendant id to the axis section', async () => {
		await situation();

		const built = await buildSearchSql(recursiveSqo(OWN_SECTION) as never, {
			principal: DEVELOPER,
			idsOnly: true,
		});
		const rows = (await sql.unsafe(built.sql, built.params as never)) as {
			section_tipo: string;
			section_id: number;
		}[];
		const matched = rows.map((row) => `${row.section_tipo}/${Number(row.section_id)}`).sort();
		// zzgua0/8 was never chosen; zzgub0/8 (the real descendant) is lost.
		expect(matched).toEqual([`${OWN_SECTION}/1`, `${OWN_SECTION}/8`]);
	});

	for (const axis of [OWN_SECTION, 'ontology35'] as const) {
		test(`section_tipo ${axis}: refused before any write`, async () => {
			await situation();

			const refusal = await refusalOf(
				toolOntologySetRecords(ctx({ section_tipo: axis, sqo: recursiveSqo(axis) })),
			);
			expect(refusal.code).toBe('request.invalid_options');
			expect(String(refusal.publicMessage)).toContain('children_recursive');
			expect(await scratchTipos()).toEqual([OWN_SECTION, OTHER_SECTION]);
		});
	}
});

// ---------------------------------------------------------------------------
// G2b — a section no tld governs is not an ontology node section
// ---------------------------------------------------------------------------

describe('G2b: a record of a non-governed section is never projected', () => {
	async function test3Record(): Promise<number> {
		await assertTestDatabase('ontology_projection_guard_native');
		const id = await createSectionRecord('test3', -1);
		test3Scratch = id;
		await sql.unsafe(
			`UPDATE matrix_test SET string = COALESCE(string, '{}'::jsonb) || $3::text::jsonb
			 WHERE section_tipo = $1 AND section_id = $2`,
			['test3', id, JSON.stringify({ ontology7: [{ id: 1, lang: 'lg-nolan', value: OWN }] })],
		);
		await clearOntologyDerivedCaches();
		return id;
	}

	test('insertDdOntologyRecord refuses a test3 record carrying ontology7', async () => {
		const id = await test3Record();
		const refusal = await refusalOf(insertDdOntologyRecord('test3', id));
		expect(refusal.code).toBe('ontology.invalid_node');
		expect(await rowOf(`${OWN}${id}`)).toBeNull();
	});

	test('insertDdOntologyRecord refuses an ontology1 row carrying ontology7', async () => {
		await seed(
			'matrix_ontology',
			UNGOVERNED_ONTOLOGY_SECTION,
			UNGOVERNED_ONTOLOGY_ID,
			OWN,
			'ungoverned',
		);
		const refusal = await refusalOf(
			insertDdOntologyRecord(UNGOVERNED_ONTOLOGY_SECTION, UNGOVERNED_ONTOLOGY_ID),
		);
		expect(refusal.code).toBe('ontology.invalid_node');
		expect(await rowOf(`${OWN}${UNGOVERNED_ONTOLOGY_ID}`)).toBeNull();
	});

	test('setRecordsInDdOntology refuses both sections as not governed, writes nothing', async () => {
		const id = await test3Record();
		await seed(
			'matrix_ontology',
			UNGOVERNED_ONTOLOGY_SECTION,
			UNGOVERNED_ONTOLOGY_ID,
			OWN,
			'ungoverned',
		);
		for (const [sectionTipo, sectionId] of [
			['test3', id],
			[UNGOVERNED_ONTOLOGY_SECTION, UNGOVERNED_ONTOLOGY_ID],
		] as const) {
			const response = await setRecordsInDdOntology({ sectionTipo, sectionId, userId: -1 });
			expect(response.ok).toBe(false);
			expect(response.errors.join(' | ')).toContain(`${sectionTipo} is not governed`);
		}
		expect(await scratchTipos()).toEqual([]);
	});

	test('tool_ontology refuses test3 and ontology1 as request.invalid_options', async () => {
		const id = await test3Record();
		await seed(
			'matrix_ontology',
			UNGOVERNED_ONTOLOGY_SECTION,
			UNGOVERNED_ONTOLOGY_ID,
			OWN,
			'ungoverned',
		);
		for (const [sectionTipo, sectionId] of [
			['test3', id],
			[UNGOVERNED_ONTOLOGY_SECTION, UNGOVERNED_ONTOLOGY_ID],
		] as const) {
			const refusal = await refusalOf(
				toolOntologySetRecords(ctx({ section_tipo: sectionTipo, section_id: sectionId })),
			);
			expect(refusal.code).toBe('request.invalid_options');
			expect(String(refusal.publicMessage)).toContain('is not an ontology node section');
		}
		expect(await scratchTipos()).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// G2c — list mode: the sqo's section axis IS the request's section
// ---------------------------------------------------------------------------

describe('G2c: list mode refuses an sqo aimed at another section', () => {
	test('section_tipo zzgua0 + sqo over zzgub0 is refused before any search or write', async () => {
		await seed('matrix_ontology', OTHER_SECTION, 7, OTHER, 'Q');
		await seed('matrix_ontology', OWN_SECTION, 7, OWN, 'P');

		const refusal = await refusalOf(
			toolOntologySetRecords(
				ctx({ section_tipo: OWN_SECTION, sqo: { section_tipo: [OTHER_SECTION] } }),
			),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(String(refusal.publicMessage)).toContain('sqo section_tipo must be exactly');
		expect(await rowOf(`${OWN}7`)).toBeNull();
		expect(await rowOf(`${OTHER}7`)).toBeNull();
	});
});

describe('G2c: list mode projects exactly what the sqo matches, under its own section', () => {
	async function situation(): Promise<void> {
		await plantNode(OWN_SECTION, OWN, 'root');
		await seed('matrix_ontology', OWN_SECTION, 1, OWN, 'one');
		await seed('matrix_ontology', OWN_SECTION, 2, OWN, 'two');
	}
	const pin = (...ids: number[]) =>
		ids.map((id) => ({ section_tipo: OWN_SECTION, section_id: String(id) }));

	for (const [spelling, axis] of [
		['array', [OWN_SECTION]],
		['bare string', OWN_SECTION],
	] as const) {
		test(`axis as ${spelling}: the matched record is projected, the unmatched one is not`, async () => {
			await situation();

			const response = await toolOntologySetRecords(
				ctx({
					section_tipo: OWN_SECTION,
					sqo: { section_tipo: axis, filter_by_locators: pin(1) },
				}),
			);
			expect(response.ok).toBe(true);
			expect(((await rowOf(`${OWN}1`)) as { term?: unknown } | null)?.term).toEqual({
				'lg-spa': 'one',
			});
			expect(await rowOf(`${OWN}2`)).toBeNull();
		});
	}

	test('every matched record is projected, at its own address', async () => {
		await situation();

		const response = await toolOntologySetRecords(
			ctx({
				section_tipo: OWN_SECTION,
				sqo: { section_tipo: [OWN_SECTION], filter_by_locators: pin(1, 2) },
			}),
		);
		expect(response.ok).toBe(true);
		expect(await scratchTipos()).toEqual([OWN_SECTION, `${OWN}1`, `${OWN}2`]);
	});

	test('a bare-string axis naming another section is refused like the array form', async () => {
		await situation();

		const refusal = await refusalOf(
			toolOntologySetRecords(
				ctx({ section_tipo: OWN_SECTION, sqo: { section_tipo: OTHER_SECTION } }),
			),
		);
		expect(refusal.code).toBe('request.invalid_options');
		expect(String(refusal.publicMessage)).toContain('sqo section_tipo must be exactly');
		expect(await scratchTipos()).toEqual([OWN_SECTION]);
	});
});

// ---------------------------------------------------------------------------
// G2e — the server's admission rule agrees with the tool's declared rule
// ---------------------------------------------------------------------------

describe("G2e: the server admits only what dd1350 declares, and never 'localontology0'", () => {
	/** dd1350 of tools/tool_ontology/register.json: exact tipos and `/regex/` strings. */
	function declaredRule(): (sectionTipo: string) => boolean {
		const register = JSON.parse(
			readFileSync(join(import.meta.dir, '../../tools/tool_ontology/register.json'), 'utf8'),
		) as unknown;
		const found: string[][] = [];
		const walk = (node: unknown): void => {
			if (Array.isArray(node)) {
				for (const item of node) walk(item);
				return;
			}
			if (node === null || typeof node !== 'object') return;
			for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
				if (key === 'dd1350' && Array.isArray(value)) {
					for (const item of value as { value?: unknown }[]) {
						if (Array.isArray(item.value)) found.push(item.value as string[]);
					}
				} else {
					walk(value);
				}
			}
		};
		walk(register);
		const values = found.flat();
		// Floor the read: the rule declares three shapes today.
		expect(values.length).toBeGreaterThanOrEqual(3);
		const matchers = values.map((value) =>
			value.startsWith('/') && value.lastIndexOf('/') > 0
				? (
						(re: RegExp) => (tipo: string) =>
							re.test(tipo)
					)(new RegExp(value.slice(1, value.lastIndexOf('/'))))
				: (tipo: string) => tipo === value,
		);
		return (sectionTipo) => matchers.some((match) => match(sectionTipo));
	}

	/** Admitted = the handler did NOT refuse the section itself (edit mode, an absent id: no write). */
	async function admitted(sectionTipo: string): Promise<boolean> {
		try {
			await toolOntologySetRecords(ctx({ section_tipo: sectionTipo, section_id: 999999901 }));
			return true;
		} catch (error) {
			return (error as { code?: string }).code !== 'request.invalid_options';
		}
	}

	test('admitted ⊆ dd1350, localontology0 in neither, and exactly the governed samples pass', async () => {
		const declared = declaredRule();
		const samples = [
			'ontology35',
			OWN_SECTION,
			'dd0',
			'localontology0',
			'test3',
			UNGOVERNED_ONTOLOGY_SECTION,
			`${OWN}999`, // an owned tipo that is not a `<tld>0` section
		];
		const admittedSet: string[] = [];
		for (const sample of samples) if (await admitted(sample)) admittedSet.push(sample);

		expect(admittedSet).toEqual(['ontology35', OWN_SECTION, 'dd0']);
		for (const sample of admittedSet) expect(declared(sample)).toBe(true);
		expect(declared('localontology0')).toBe(false);
		expect(admittedSet).not.toContain('localontology0');
		expect(await scratchTipos()).toEqual([]);
	});
});
