/**
 * LITERAL-main dataframe read (component_iri + its dd560 label frame) —
 * TS-NATIVE half (DEC-14b P1), the survival twin of
 * test/parity/iri_dataframe_differential.test.ts (which needs the live PHP
 * oracle and dies without it).
 *
 * Same seed as the differential: a scratch test3 record carrying a test140
 * iri item plus a paired dd560 dd490 entry (id_key 1 → dd1706/121 'Zenon').
 * The list-read projection (the differential's exact `comparable` field set)
 * is DEEP-EQUAL against a GOLDEN captured from the LIVE PHP ORACLE on this
 * exact seed (2026-07-10 UTC, scratchpad capture_dec14b_p1.ts — the capture
 * run verified TS === PHP byte-for-byte on the comparable projection).
 * Goldens live in fixtures/iri_dataframe_native/; NEVER regenerate them from
 * TS output — recapture from the PHP oracle with the same seed.
 *
 * Oracle-pinned semantics frozen here, IN ORDER:
 *   1. the dd560 frame item (mode 'edit' from the frame node, entries = the
 *      paired dd490 entry + paginated_key, pagination {1, 30, 0});
 *   2. the dd1715 label child at dd1706/121 (mode 'list' default);
 *   3. the test140 iri item itself (frames precede the literal — PHP
 *      component_iri_json merges the subdatum first).
 *
 * Scratch id: test3/900312 in matrix_test — the reserved-high (900000+)
 * range, clear of the canonical ids (1/2/27) and of the sibling gates'
 * 900311/900313 twins. Direct INSERT (no counter bump) so the golden pins
 * section_id byte-stable. NO ontology mutation: dd560/test140 ship in the
 * ontology (unlike the has_dataframe gate, which provisions its own frame node —
 * test900 since 2026-07-12, when the seeded ontology grew into its old test218).
 *
 * @twin-of      test/parity/iri_dataframe_differential.test.ts
 * @twin-status  retired
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { assertMatrixTable } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import golden from './fixtures/iri_dataframe_native/list_items.golden.json';

const SECTION = 'test3';
const RECORD_ID = 900312;

/**
 * The frame's TARGET record — this gate CREATES it (2026-07-13).
 *
 * It used to read dd1706/121 'Zenon', a row of the old shared dev DB. dd1706/dd1715/dd490
 * are ONTOLOGY and ship in the install seed; the RECORD does not, so on a fresh install the
 * frame resolved to nothing and the deep-equal failed with an unreadable diff. The gate now
 * mints its own row at a reserved-high id and deletes it after — no dependency on any record
 * the installation happens to hold. Same fixture the has_dataframe gate builds; the two use
 * DIFFERENT target ids so they never collide when the suite runs them in parallel.
 */
const TARGET_SECTION_TIPO = 'dd1706';
const TARGET_ID = 900122; // has_dataframe uses 900121
const TARGET_LABEL_TIPO = 'dd1715';
const TARGET_LABEL_VALUE = 'Zenon'; // the value the oracle capture resolved — keep verbatim

let tsItems: Record<string, unknown>[] = [];
/** Resolved (never hardcoded) matrix table for dd1706, and whether WE made the row. */
let targetTable = '';
let targetCreated = false;

/** The differential's exact comparable projection — the live-verified contract. */
function comparable(item: Record<string, unknown>): Record<string, unknown> {
	return {
		tipo: item.tipo,
		section_tipo: item.section_tipo,
		section_id: item.section_id,
		mode: item.mode,
		lang: item.lang,
		from_component_tipo: item.from_component_tipo ?? null,
		entries: item.entries ?? null,
		pagination: item.pagination ?? null,
		counter: item.counter ?? null,
		row_section_id: item.row_section_id ?? null,
		parent_tipo: item.parent_tipo ?? null,
	};
}

async function sweepRecord(): Promise<number> {
	const deleted = (await sql.unsafe(
		'DELETE FROM matrix_test WHERE section_tipo = $1 AND section_id = $2 RETURNING id',
		[SECTION, RECORD_ID],
	)) as unknown[];
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		SECTION,
		RECORD_ID,
	]);
	return deleted.length;
}

beforeAll(async () => {
	await sweepRecord(); // pre-clean a crashed prior run

	// Mint the frame's target record. PRECONDITION: the coordinate must be free — never
	// write over, and never delete, a record this gate did not create.
	const table = await getMatrixTableFromTipo(TARGET_SECTION_TIPO);
	if (table === null) throw new Error(`iri gate: no matrix table for '${TARGET_SECTION_TIPO}'`);
	assertMatrixTable(table); // identifier allowlist (spec §7.6)
	targetTable = table;
	const occupied = await sql.unsafe(
		`SELECT section_id FROM ${targetTable} WHERE section_tipo = $1 AND section_id = $2`,
		[TARGET_SECTION_TIPO, TARGET_ID],
	);
	if (occupied.length > 0) {
		throw new Error(
			`iri gate: ${TARGET_SECTION_TIPO}/${TARGET_ID} already exists — this gate creates and then DELETES that record, so it will not touch one it did not make. Move TARGET_ID to a free reserved-high id (and rename it in the golden, where it is only an identifier).`,
		);
	}
	await sql.unsafe(
		`INSERT INTO ${targetTable} (section_id, section_tipo, string)
		 VALUES ($1, $2, jsonb_build_object($3::text, $4::text::jsonb))`,
		[
			TARGET_ID,
			TARGET_SECTION_TIPO,
			TARGET_LABEL_TIPO,
			JSON.stringify([{ id: 1, lang: 'lg-nolan', value: TARGET_LABEL_VALUE }]),
		],
	);
	targetCreated = true;

	const iriValue = [{ id: 1, iri: 'https://example.org/frame-native', lang: 'lg-nolan' }];
	const frameBag = [
		{
			id: 1,
			type: 'dd490',
			id_key: 1,
			section_id: String(TARGET_ID),
			section_tipo: TARGET_SECTION_TIPO,
			from_component_tipo: 'dd560',
			main_component_tipo: 'test140',
		},
	];
	await sql.unsafe(
		`INSERT INTO matrix_test (section_id, section_tipo, iri, relation)
		 VALUES ($1, $2, jsonb_build_object('test140', $3::text::jsonb), jsonb_build_object('dd560', $4::text::jsonb))`,
		[RECORD_ID, SECTION, JSON.stringify(iriValue), JSON.stringify(frameBag)],
	);

	const rqo = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: SECTION,
			section_tipo: SECTION,
			action: 'search',
			mode: 'list',
			lang: 'lg-spa',
		},
		sqo: {
			section_tipo: [SECTION],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: SECTION, section_id: String(RECORD_ID) }],
		},
		show: {
			ddo_map: [{ tipo: 'test140', section_tipo: SECTION, parent: SECTION, mode: 'list' }],
		},
	};

	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	const principal = await resolvePrincipal(-1);
	tsItems = (
		(
			(
				await dispatchRqo(
					structuredClone(rqo) as never,
					{
						requestId: 't',
						clientIp: '127.0.0.1',
						session,
						csrfCandidate: session?.csrfToken ?? null,
						principal,
					} as never,
				)
			).body as { data?: { data?: unknown[] } }
		).data?.data ?? []
	).slice(1) as Record<string, unknown>[];
}, 60000);

afterAll(async () => {
	// Undo the target record ONLY if we created it: if the precondition refused a coordinate
	// that was already taken, that row belongs to someone else and must survive untouched.
	if (targetCreated && targetTable !== '') {
		await sql.unsafe(`DELETE FROM ${targetTable} WHERE section_tipo = $1 AND section_id = $2`, [
			TARGET_SECTION_TIPO,
			TARGET_ID,
		]);
		targetCreated = false;
	}
	// A seeded scratch row that deletes NOTHING means the fixed id collided or
	// something swept it mid-run — fail loudly rather than mask it.
	if ((await sweepRecord()) === 0) {
		throw new Error(
			`Scratch cleanup deleted 0 rows for ${SECTION}/${RECORD_ID} (matrix_test) — the seed vanished mid-run.`,
		);
	}
});

describe('iri label-dataframe read (TS-native, oracle-captured golden)', () => {
	test('frame + label child + iri item DEEP-EQUAL the golden, in order', () => {
		// Fixture integrity floors — the semantics the differential pinned must
		// be IN the golden (guards a truncated/regenerated fixture; the engine
		// assertion is the deep-equal below).
		const items = golden.items as Record<string, unknown>[];
		expect(items.map((item) => item.tipo)).toEqual(['dd560', 'dd1715', 'test140']);
		expect(items[0]?.mode).toBe('edit'); // dd560's node-declared frame mode
		expect(items[0]?.pagination).toEqual({ total: 1, limit: 30, offset: 0 } as never);
		expect(JSON.stringify(items[0]?.entries)).toContain('"paginated_key":0');
		expect(items[2]?.counter).toBe(0); // literal carries counter

		expect(tsItems.map(comparable)).toEqual(items as never);
	});
});

/** A get_data of the iri (test140) on the scratch record, optionally with a show. */
async function getDataIri(
	mode: 'edit' | 'list',
	show: Record<string, unknown>[] | null,
): Promise<{
	items: Record<string, unknown>[];
	context: Record<string, unknown>[];
	errorCode: string | null;
}> {
	const rqo: Record<string, unknown> = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			action: 'get_data',
			model: 'component_iri',
			tipo: 'test140',
			section_tipo: SECTION,
			section_id: RECORD_ID,
			mode,
			lang: 'lg-spa',
		},
		sqo: {
			section_tipo: [SECTION],
			limit: 10,
			offset: 0,
			filter_by_locators: [{ section_tipo: SECTION, section_id: RECORD_ID }],
		},
	};
	if (show !== null) rqo.show = { ddo_map: show };
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	const body = (
		await dispatchRqo(
			structuredClone(rqo) as never,
			{
				requestId: 't',
				clientIp: '127.0.0.1',
				session,
				csrfCandidate: session?.csrfToken ?? null,
				principal: await resolvePrincipal(-1),
			} as never,
		)
	).body as {
		data?: { data?: Record<string, unknown>[]; context?: Record<string, unknown>[] };
		error?: { code?: string };
	};
	return {
		items: body.data?.data ?? [],
		context: body.data?.context ?? [],
		errorCode: body.error?.code ?? null,
	};
}

describe('iri get_data: the dd560 frame context is its EMITTED node (W3)', () => {
	test('one dd560 context, in the mode the frame item carries, the PHP injection kept (view line, level >= 2)', async () => {
		const { items, context, errorCode } = await getDataIri('list', null);
		expect(errorCode).toBeNull();
		const frameItem = items.find((item) => item.tipo === 'dd560');
		expect(frameItem).toBeDefined();
		const frames = context.filter((entry) => entry.tipo === 'dd560');
		expect(frames).toHaveLength(1);
		expect(frames[0]?.mode).toBe(frameItem?.mode as never);
		expect(frames[0]?.view).toBe('line');
		expect(Number(frames[0]?.permissions)).toBeGreaterThanOrEqual(2);
	});

	test('a stage-1 show declaring dd560 with a view: the CONTEXT follows it, as the data did', async () => {
		const { items, context, errorCode } = await getDataIri('list', [
			{ tipo: 'dd560', parent: 'self', section_tipo: SECTION, view: 'mini' },
		]);
		expect(errorCode).toBeNull();
		expect(items.some((item) => item.tipo === 'dd560')).toBe(true);
		const frames = context.filter((entry) => entry.tipo === 'dd560');
		expect(frames).toHaveLength(1);
		// the synthetic own entry would say 'line' whatever the request declared
		expect(frames[0]?.view).toBe('mini');
	});
});
