/**
 * DELETE_TAG GATE (dd_component_text_area_api::delete_tag, ported 2026-07-30 —
 * WC-077; PHP component_text_area::delete_tag_from_all_langs).
 *
 * tool_indexation's tag delete is two steps: remove the MARKS from the text in
 * every language (this), then remove the portal LOCATOR (already ported). Step
 * one answered HTTP 400 until now, so deleting an index tag stripped the
 * locator and left orphan marks behind in every language. These tests pin:
 *
 *   - all-langs reach: every language slice that holds the tag is cleaned, in
 *     ONE save per language, and the sibling language's items are neither
 *     dropped nor relocated;
 *   - surgical scope: another tag id in the same text survives untouched, and
 *     so does the surrounding markup;
 *   - IDEMPOTENCY — the property the per-lang (non-atomic) design rests on: a
 *     second delete removes nothing, reports result:false, and writes NO new
 *     Time Machine row;
 *   - one TM row per changed language on the first call;
 *   - the id is VALIDATED, never interpolated raw into the pattern (PHP did
 *     interpolate): a non-numeric or injected tag_id throws;
 *   - the type allowlist: 'index'/'reference' only, anything else refused with
 *     the type named.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). The host is
// `test3` (a section storing in matrix_test) and the text_area is `test17`, whose
// `is_translatable` is TRUE in the shipped test ontology — which is the property
// this gate rests on: without it there are no language slices to reach.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { componentTextAreaApiActions } from '../../src/core/api/handlers/dd_component_text_area_api.ts';
import { deleteTagFromAllLangs } from '../../src/core/components/component_text_area/tag_delete.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { readComponentItems } from '../../src/core/resolve/component_data.ts';
import { markPatternById } from '../../src/core/resolve/tr_marks.ts';
import { SUPERUSER_ID } from '../../src/core/security/permissions.ts';
import { refusalOfSync } from '../helpers/refusal.ts';

/**
 * RESOLVED, never assumed: a cloned `test` section carries its own
 * `matrix_table` relation (test3 → `matrix_test`), so a gate that hard-codes
 * `matrix` inserts where the engine will never look for it — every read then
 * answers "record not found" and the gate reddens on its own fixture.
 */
const TABLE = 'matrix_test';
const HOST_SECTION = 'test3';
const TEXT_AREA = 'test17'; // component_text_area, translatable
const SPA = 'lg-spa';
const ENG = 'lg-eng';
const USER_ID = 1; // the superuser the suite runs writes as

let hostId = 0;

/** `[index-n-7-lbl-data::data]texto[/index-n-7-lbl-data::data]` around some text. */
function indexed(tagId: number, inner: string): string {
	return `[index-n-${tagId}-t${tagId}-data::data]${inner}[/index-n-${tagId}-t${tagId}-data::data]`;
}

async function storedItems(): Promise<{ id?: number; lang?: string; value?: string }[]> {
	const record = await readMatrixRecord(TABLE, HOST_SECTION, hostId);
	if (record === null) return [];
	return (readComponentItems(record, TEXT_AREA, 'component_text_area') ?? []) as {
		id?: number;
		lang?: string;
		value?: string;
	}[];
}

async function textOf(lang: string): Promise<string> {
	const items = await storedItems();
	return items.find((item) => item.lang === lang)?.value ?? '';
}

async function tmRowCount(): Promise<number> {
	const rows = (await sql`
		select count(*)::int as total
		from matrix_time_machine
		where section_tipo = ${HOST_SECTION} and section_id = ${hostId} and tipo = ${TEXT_AREA}
	`) as { total: number }[];
	return rows[0]?.total ?? 0;
}

beforeAll(async () => {
	hostId = await insertMatrixRecordWithCounter(TABLE, HOST_SECTION, {
		string: {
			[TEXT_AREA]: [
				{
					id: 1,
					lang: SPA,
					value: `<p>${indexed(7, 'siete')} y ${indexed(9, 'nueve')}</p>`,
				},
				{
					id: 1,
					lang: ENG,
					value: `<p>${indexed(7, 'seven')} and ${indexed(9, 'nine')}</p>`,
				},
			],
		},
	});
});

afterAll(async () => {
	if (hostId > 0) await deleteMatrixRecord(TABLE, HOST_SECTION, hostId);
});

const request = (tagId: string, tagType: 'index' | 'reference' = 'index') => ({
	componentTipo: TEXT_AREA,
	sectionTipo: HOST_SECTION,
	sectionId: hostId,
	tagId,
	tagType,
	userId: USER_ID,
});

describe('deleteTagFromAllLangs', () => {
	test('removes the tag from EVERY lang, leaves the other tag and the siblings intact', async () => {
		const tmBefore = await tmRowCount();

		const outcome = await deleteTagFromAllLangs(request('7'));

		expect(outcome.error).toBeUndefined();
		// 2 marks (open + close) x 2 langs
		expect(outcome.removedCount).toBe(4);
		expect(outcome.langsChanged.sort()).toEqual([ENG, SPA].sort());

		// Tag 7 gone from both langs; tag 9 and the surrounding markup untouched.
		const spanish = await textOf(SPA);
		const english = await textOf(ENG);
		expect(spanish).toBe(`<p>siete y ${indexed(9, 'nueve')}</p>`);
		expect(english).toBe(`<p>seven and ${indexed(9, 'nine')}</p>`);

		// Sibling languages survive the lang-sliced write: both items still there,
		// each with its own lang and its item id preserved.
		const items = await storedItems();
		expect(items).toHaveLength(2);
		expect(items.map((item) => item.lang).sort()).toEqual([ENG, SPA].sort());
		expect(items.every((item) => item.id === 1)).toBe(true);

		// ONE Time Machine row per changed lang (one save each), each preceded by
		// its save-before row: the text is seeded RAW, with no history
		// (re-pinned 2026-11-12, T1-21).
		expect(await tmRowCount()).toBe(tmBefore + 4);
	});

	test('IDEMPOTENT: a second delete removes nothing and writes no TM row', async () => {
		const tmBefore = await tmRowCount();
		const spanishBefore = await textOf(SPA);

		const outcome = await deleteTagFromAllLangs(request('7'));

		expect(outcome.removedCount).toBe(0);
		expect(outcome.langsChanged).toEqual([]);
		expect(outcome.error).toBeUndefined();
		expect(await textOf(SPA)).toBe(spanishBefore);
		expect(await tmRowCount()).toBe(tmBefore);
	});

	test('a tag id that appears in only ONE lang cleans just that lang', async () => {
		const soloId = await insertMatrixRecordWithCounter(TABLE, HOST_SECTION, {
			string: {
				[TEXT_AREA]: [
					{ id: 1, lang: SPA, value: `<p>${indexed(4, 'cuatro')}</p>` },
					{ id: 1, lang: ENG, value: '<p>no tags here</p>' },
				],
			},
		});
		try {
			const outcome = await deleteTagFromAllLangs({ ...request('4'), sectionId: soloId });
			expect(outcome.langsChanged).toEqual([SPA]);
			expect(outcome.removedCount).toBe(2);
		} finally {
			await deleteMatrixRecord(TABLE, HOST_SECTION, soloId);
		}
	});

	test('reference tags are deletable by id too', async () => {
		const refId = await insertMatrixRecordWithCounter(TABLE, HOST_SECTION, {
			string: {
				[TEXT_AREA]: [
					{
						id: 1,
						lang: SPA,
						value:
							'<p>[reference-n-1-r1-data::data]cita[/reference-n-1-r1-data::data] y [reference-n-2-r2-data::data]otra[/reference-n-2-r2-data::data]</p>',
					},
				],
			},
		});
		try {
			const outcome = await deleteTagFromAllLangs({
				...request('1', 'reference'),
				sectionId: refId,
			});
			expect(outcome.removedCount).toBe(2);
			const record = await readMatrixRecord(TABLE, HOST_SECTION, refId);
			const items = (readComponentItems(record!, TEXT_AREA, 'component_text_area') ?? []) as {
				value?: string;
			}[];
			expect(items[0]?.value).toBe(
				'<p>cita y [reference-n-2-r2-data::data]otra[/reference-n-2-r2-data::data]</p>',
			);
		} finally {
			await deleteMatrixRecord(TABLE, HOST_SECTION, refId);
		}
	});

	test('a record with no data at all is a no-op, not a crash', async () => {
		const bareId = await insertMatrixRecordWithCounter(TABLE, HOST_SECTION, {});
		try {
			const outcome = await deleteTagFromAllLangs({ ...request('7'), sectionId: bareId });
			expect(outcome).toEqual({ langsChanged: [], removedCount: 0 });
		} finally {
			await deleteMatrixRecord(TABLE, HOST_SECTION, bareId);
		}
	});
});

/**
 * ENVELOPE v2 (engineering/ERRORS_SPEC.md §4): a refusal is a THROWN registry
 * code — the handler builds no failure body, and the dispatch chokepoint
 * converts it (registry status, `{ok:false, error:{code}}`). This unwraps the
 * throw so each case can assert the CODE, which is the contract now.
 */
async function refusalOf(call: Promise<unknown>): Promise<DedaloError> {
	const outcome = await call.then(
		(value) => ({ threw: false as const, value }),
		(error: unknown) => ({ threw: true as const, error }),
	);
	if (!outcome.threw) {
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value)}`);
	}
	if (!(outcome.error instanceof DedaloError)) throw outcome.error;
	return outcome.error;
}

describe('dd_component_text_area_api::delete_tag envelope', () => {
	/** The handler reads its identity from the request context (requirePrincipal). */
	const context = {
		requestId: 'test',
		clientIp: '127.0.0.1',
		session: null,
		csrfCandidate: null,
		// SUPERUSER: the canonical write gate resolves grants from the matrix, so a
		// plain isGlobalAdmin principal with no grant on test3/test17 is DENIED
		// (verified — that denial is the gate working, see the permissions test).
		principal: { userId: SUPERUSER_ID, isGlobalAdmin: true, isDeveloper: true },
	};
	const handler = () => {
		const action = componentTextAreaApiActions.delete_tag;
		if (action === undefined) throw new Error('delete_tag is not registered');
		return action;
	};
	const call = (source: Record<string, unknown>, options: Record<string, unknown>) =>
		handler()({ action: 'delete_tag', source, options } as unknown as Rqo, context);

	const source = () => ({ tipo: TEXT_AREA, section_tipo: HOST_SECTION, section_id: hostId });

	test('a removal reports result:true with the PHP message bytes', async () => {
		const target = await insertMatrixRecordWithCounter(TABLE, HOST_SECTION, {
			string: { [TEXT_AREA]: [{ id: 1, lang: SPA, value: `<p>${indexed(5, 'cinco')}</p>` }] },
		});
		try {
			const result = await call(
				{ tipo: TEXT_AREA, section_tipo: HOST_SECTION, section_id: target },
				{ tag_id: '5', type: 'index' },
			);
			expect(result.status).toBe(200);
			expect(result.body?.ok).toBe(true);
			// PHP: result = ($n_deleted > 0). The client's editor-tag removal keys on
			// this exact truthiness — it is the answer, not a status word.
			expect(result.body?.data).toBe(true);
			expect(result.body?.notices).toBeUndefined();
			// The two owned top-level keys survive as extension keys.
			expect(result.body?.langs_changed).toEqual([SPA]);
			expect(result.body?.removed_count).toBe(2);
		} finally {
			await deleteMatrixRecord(TABLE, HOST_SECTION, target);
		}
	});

	test('nothing matched stays FALSY — the client depends on it', async () => {
		// tag 7 was already deleted by the first describe block. "Nothing matched"
		// is a FALSY SUCCESS, never an error: the client keeps its own markup.
		const result = await call(source(), { tag_id: '7', type: 'index' });
		expect(result.body?.ok).toBe(true);
		expect(result.body?.data).toBe(false);
		expect(result.body?.removed_count).toBe(0);
	});

	test('an unsupported tag type is refused, naming the CLOSED supported set', async () => {
		const refusal = await refusalOf(call(source(), { tag_id: '3', type: 'note' }));
		expect(refusal.code).toBe('request.invalid_options');
		// The vetted public sentence states what IS supported; the rejected value
		// (caller data) rides the log message only.
		expect(refusal.publicMessage).toContain('options.type must be one of');
		expect(refusal.message).toContain("tag type 'note' is not deletable by id");
	});

	test('a malformed tag_id is a rejected request, not a 500', async () => {
		const refusal = await refusalOf(call(source(), { tag_id: '7|.*', type: 'index' }));
		expect(refusal.code).toBe('request.invalid_options');
		expect(refusal.spec.status).toBe(400);
		// The validator's own message names the offending id: cause only.
		expect(refusal.publicMessage).toBe('options.tag_id is malformed');
	});

	test('missing coordinates are refused', async () => {
		const refusal = await refusalOf(call({ tipo: TEXT_AREA }, { tag_id: '7', type: 'index' }));
		expect(refusal.code).toBe('request.invalid_source');
		expect(refusal.spec.status).toBe(400);
	});
});

describe('markPatternById — the id is validated, never interpolated raw', () => {
	test('matches the open AND close mark of one id, any state', () => {
		const text = `${indexed(7, 'a')}${indexed(70, 'b')}[index-d-7-x-data::data]`;
		const cleaned = text.replace(markPatternById('index', '7'), '');
		// Both id-7 marks gone (state n AND state d) while their INNER TEXT stays;
		// id 70 must NOT be touched by the id-7 pattern (no prefix matching).
		expect(cleaned).toBe(`a${indexed(70, 'b')}`);
	});

	test('a non-numeric or injected id throws (PHP interpolated it raw)', () => {
		expect(() => markPatternById('index', 'abc')).toThrow(/not a valid tag id/);
		expect(() => markPatternById('index', '7|.*')).toThrow(/not a valid tag id/);
		expect(() => markPatternById('index', '')).toThrow(/not a valid tag id/);
		expect(() => markPatternById('index', '1234567')).toThrow(/not a valid tag id/);
		// The guard is a TYPED caller refusal (ERRORS_SPEC §7) — client input.
		expect(refusalOfSync(() => markPatternById('index', '7|.*')).code).toBe('request.invalid');
	});

	test('a type outside the allowlist throws', () => {
		expect(() => markPatternById('note' as 'index', '3')).toThrow(/not deletable by id/);
		expect(refusalOfSync(() => markPatternById('note' as 'index', '3')).code).toBe(
			'request.invalid',
		);
	});
});
