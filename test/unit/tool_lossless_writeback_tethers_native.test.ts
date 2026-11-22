/**
 * THE BEHAVIOUR TETHERS of tool_lossless_writeback_tripwire's SERVER cells — executed on
 * the SUITE database (DB tier). The census (hermetic) reads spellings and resolved edges;
 * what it cannot read is whether a door still DOES what its cell claims. Each tether here
 * runs the real path on records of a scratch situation (generic `zz` TLD, built and torn
 * down by this file) and asserts the claim with its counterfactual:
 *
 *   - a server PENDING cell's tether asserts the DEFECT still happens, so an in-place fix
 *     (door unchanged) is red and forces the cell to move;
 *   - a server `refuses` cell's tether asserts the REFUSAL still happens — a `must_contain`
 *     spelling survives `if (guard(x)) log(); return write()` — and that it is not a
 *     blanket refusal.
 *
 * TOTALITY composes over test/helpers/tool_writeback_tethers.ts: the census holds every
 * server PENDING / `refuses` cell to a title in WRITEBACK_TETHER_TITLES, and the last test
 * here holds the titles REGISTERED through `behaviourTether` EQUAL to that list — a
 * deleted tether, or one turned into `test.skip`, is red.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readMatrixRecord } from '../../src/core/db/matrix.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getMatrixTableFromTipo } from '../../src/core/ontology/resolver.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import { saveComponentData } from '../../src/core/section/record/save_component.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import {
	pollTranscriptionCompletion,
	saveTranscriptionResult,
} from '../../src/core/tools/transcription_asr.ts';
import {
	babelProvider,
	translateAndWrite,
	translationFailure,
} from '../../src/core/tools/translation.ts';
import { toolTimeMachineBulkRevert } from '../../tools/tool_time_machine/server/bulk_revert.ts';
import { WRITEBACK_TETHER_TITLES, WRITEBACK_TETHERS } from '../helpers/tool_writeback_tethers.ts';
import { superuserTranslationGrant } from '../helpers/translation_grant.ts';

/** Titles registered through `behaviourTether` — filled at collection, read at run time. */
const REGISTERED = new Set<string>();

/**
 * Registers a tether as a RUNNING test and records its title: the totality test below
 * compares what really registered with WRITEBACK_TETHER_TITLES.
 */
function behaviourTether(title: string, body: () => Promise<void>): void {
	REGISTERED.add(title);
	test(title, body);
}

const TLD = 'zzlwt';
const SECTION = `${TLD}1`;
const TEXT = `${TLD}2`; // input_text, translatable (lang-SLICED, 'string' column)
const DATE = `${TLD}3`;
const TABLE = 'matrix_test';
const USER_ID = -1;
const SITUATION = situation({
	tld: TLD,
	name: 'tool_lossless_writeback_tethers',
	nodes: [
		{ tipo: SECTION, parent: 'test1', model: 'section', term: { 'lg-eng': 'Tethers' } },
		{
			tipo: TEXT,
			parent: SECTION,
			model: 'component_input_text',
			term: { 'lg-eng': 'Text' },
			is_translatable: true,
		},
		{ tipo: DATE, parent: SECTION, model: 'component_date', term: { 'lg-eng': 'Date' } },
	],
});

describe('tool_lossless_writeback — the server cells, EXECUTED (behaviour, not spelling)', () => {
	/** dd800 run records (and the revert's own) — outside the situation's section. */
	const runs: number[] = [];
	let bulkTable = '';

	const setText = async (id: number, lang: string, value: string, bulk: number | null) => {
		const saved = await saveComponentData({
			componentTipo: TEXT,
			sectionTipo: SECTION,
			sectionId: id,
			lang,
			changedData: [{ action: 'set_data', value: [{ id: 1, lang, value }] }] as never,
			userId: USER_ID,
			bulkProcessId: bulk,
		});
		expect(saved.ok).toBe(true);
	};
	const stored = async (id: number) => {
		const record = await readMatrixRecord(TABLE, SECTION, id);
		if (record === null) return null;
		const column = (name: 'string' | 'date', tipo: string) =>
			((record.columns[name] ?? {}) as Record<string, unknown>)[tipo];
		return { text: column('string', TEXT), date: column('date', DATE) };
	};
	const langValues = (items: unknown) =>
		(Array.isArray(items) ? items : []).map((item) => {
			const { lang, value } = item as { lang?: string; value?: unknown };
			return `${lang}:${String(value)}`;
		});

	beforeAll(async () => {
		await assertTestDatabase('tool_lossless_writeback_tethers');
		await ensureSituation(SITUATION);
		bulkTable = (await getMatrixTableFromTipo('dd800')) as string;
		expect(await getMatrixTableFromTipo(SECTION)).toBe(TABLE);
	}, 60_000);

	afterAll(async () => {
		await assertTestDatabase('tool_lossless_writeback_tethers');
		await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1', [SECTION]);
		await sql.unsafe('DELETE FROM dedalo_ts_record_generation WHERE section_tipo = $1', [SECTION]);
		await sql.unsafe(`DELETE FROM "${TABLE}" WHERE section_tipo = $1`, [SECTION]);
		for (const id of runs) {
			await sql.unsafe(
				`DELETE FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = $1`,
				[id],
			);
			await sql.unsafe(
				`DELETE FROM matrix_time_machine WHERE section_tipo = 'dd800' AND section_id = $1`,
				[id],
			);
		}
		await sql.unsafe(`DELETE FROM matrix_activity WHERE data->>'section_tipo' = $1`, [SECTION]);
		// ZERO RESIDUE, measured — not assumed from the DELETEs above
		const residue = async (query: string, params: unknown[]) =>
			Number(((await sql.unsafe(query, params)) as { n: number | string }[])[0]?.n ?? -1);
		expect({
			records: await residue(`SELECT count(*) AS n FROM "${TABLE}" WHERE section_tipo = $1`, [
				SECTION,
			]),
			timeMachine: await residue(
				'SELECT count(*) AS n FROM matrix_time_machine WHERE section_tipo = $1',
				[SECTION],
			),
			activity: await residue(
				`SELECT count(*) AS n FROM matrix_activity WHERE data->>'section_tipo' = $1`,
				[SECTION],
			),
			runs: await residue(
				`SELECT count(*) AS n FROM "${bulkTable}" WHERE section_tipo = 'dd800' AND section_id = ANY($1::text::int[])`,
				[`{${runs.join(',')}}`],
			),
		}).toEqual({ records: 0, timeMachine: 0, activity: 0, runs: 0 });
		expect(await dropSituation(SITUATION)).toBe(0);
	});

	behaviourTether(WRITEBACK_TETHERS.emptyBody, async () => {
		// The WHOLE server write path — translateAndWrite with the REAL babelProvider (its
		// guarded fetch, its response screen) and the real item loop, locked merge and
		// chokepoint write — on a record of the scratch situation, with only the network
		// replaced by an HTTP 200. An EMPTY body (a service that does not support the
		// language pair) must be REFUSED and the curator's translation KEPT; the
		// COUNTERFACTUAL — a body with text — must be written, or the refusal is vacuous.
		const sectionId = await createSectionRecord(SECTION, USER_ID);
		await setText(sectionId, 'lg-spa', 'El texto de origen.', null);
		await setText(sectionId, 'lg-eng', 'The text a curator already translated.', null);
		expect(langValues((await stored(sectionId))?.text).sort()).toEqual([
			'lg-eng:The text a curator already translated.',
			'lg-spa:El texto de origen.',
		]);
		const realFetch = globalThis.fetch;
		const stubbedCalls: string[] = [];
		const translate = async (body: string) => {
			globalThis.fetch = (async (input: unknown) => {
				stubbedCalls.push(String(input instanceof Request ? input.url : input));
				return new Response(body, { status: 200 });
			}) as unknown as typeof fetch;
			try {
				return await translateAndWrite(await superuserTranslationGrant(SECTION, TEXT, sectionId), {
					model: 'component_input_text',
					sourceLang: 'lg-spa',
					targetLang: 'lg-eng',
					provider: babelProvider,
					// a PUBLIC IP literal: the guard's no-lookup path, never dialled (fetch is stubbed)
					uri: 'https://93.184.216.34/translate',
					key: 'k',
				});
			} finally {
				globalThis.fetch = realFetch;
			}
		};
		const english = async () =>
			langValues((await stored(sectionId))?.text).filter((entry) => entry.startsWith('lg-eng:'));

		// The stub COUNTS its calls: if the provider's transport ever stops going through
		// the global fetch, the counts below are red (no injectable transport today).
		const refused = await translate('');
		expect(stubbedCalls.length, `provider calls seen by the stub: ${stubbedCalls.join(', ')}`).toBe(
			1,
		);
		expect({ ok: refused.ok, emptyResult: refused.emptyResult, english: await english() }).toEqual({
			ok: false,
			emptyResult: true,
			english: ['lg-eng:The text a curator already translated.'],
		});
		// …and runAutomaticTranslation throws it as its own wire code, not provider_failed
		expect(translationFailure(refused).code).toBe('translation.empty_result');

		// counterfactual: a real translation IS written over the same slot
		const written = await translate('The source text.');
		expect(stubbedCalls.length).toBe(2);
		expect({ ok: written.ok, english: await english() }).toEqual({
			ok: true,
			english: ['lg-eng:The source text.'],
		});
	});

	behaviourTether(WRITEBACK_TETHERS.deleteIfSafe, async () => {
		const run = await createSectionRecord('dd800', USER_ID);
		runs.push(run);
		const curated = await createSectionRecord(SECTION, USER_ID, new Date(), undefined, {
			bulkProcessId: run,
		});
		await setText(curated, 'lg-spa', 'imported', run);
		// a value the run did not write: a curator's, after the run
		const foreign = await saveComponentData({
			componentTipo: DATE,
			sectionTipo: SECTION,
			sectionId: curated,
			lang: 'lg-nolan',
			changedData: [{ action: 'insert', value: { start: { year: 1999 } } }] as never,
			userId: USER_ID,
		});
		expect(foreign.ok).toBe(true);
		// the curator's value AS STORED — the survival check below compares against it
		const curatorValue = (await stored(curated))?.date;
		expect(JSON.stringify(curatorValue ?? null)).toContain('"year":1999');
		const untouched = await createSectionRecord(SECTION, USER_ID, new Date(), undefined, {
			bulkProcessId: run,
		});
		await setText(untouched, 'lg-spa', 'imported', run);

		const response = await toolTimeMachineBulkRevert({
			principal: await resolvePrincipal(USER_ID),
			userId: USER_ID,
			options: { bulk_process_id: run },
			background: false,
		});
		const data = (response.data ?? {}) as {
			bulk_process_id?: number;
			skipped?: { reason: string; section_id: number }[];
		};
		// the revert's own run record is swept even when an assertion below is red
		if (typeof data.bulk_process_id === 'number') runs.push(data.bulk_process_id);
		expect(response.ok).toBe(true);

		const kept = await stored(curated);
		expect(kept, 'the revert DELETED a record holding a curator’s value').not.toBeNull();
		expect(kept?.date, 'the curator’s value did not survive the revert').toEqual(curatorValue);
		expect((data.skipped ?? []).map(({ reason, section_id }) => `${reason}:${section_id}`)).toEqual(
			[`created_record_kept:${curated}`],
		);
		// the counterfactual: a record holding only the run's own values IS deleted
		expect(await stored(untouched), 'the refusal became a blanket refusal').toBeNull();
	});

	behaviourTether(WRITEBACK_TETHERS.transcription, async () => {
		// Driven through the cell's DOOR (pollTranscriptionCompletion — the poll's status
		// provider is the one seam replaced: a finished job answering status 3), so a second
		// write path inside the door that skips the guarded save is red here too.
		const segments = [{ start: 0, end: 4, text: ' Machine words.' }];
		let providerCalls = 0;
		const poll = (sectionId: number) =>
			pollTranscriptionCompletion(
				{
					status: {
						uri: '',
						key: '',
						avUrl: null,
						engine: 'babel',
						userId: USER_ID,
						entityName: '',
						pid: 1,
						lang: 'lg-eng',
					},
					lang: 'lg-eng',
					transcriptionDdo: { component_tipo: TEXT, section_tipo: SECTION, section_id: sectionId },
					userId: USER_ID,
				},
				{
					provider: async () => {
						providerCalls++;
						return { status: 3, transcription_data: { segments } };
					},
					maxAttempts: 1,
					// The engine's guarded save itself (the save is REQUIRED of the caller —
					// integrator request 12): the tether is the save's own lossless write,
					// as the principal the poll's caller resolves (T2-S05-a: the writer asks
					// the write door itself).
					save: async (input) =>
						saveTranscriptionResult({ ...input, principal: await resolvePrincipal(input.userId) }),
				},
			);

		const curated = await createSectionRecord(SECTION, USER_ID);
		await setText(curated, 'lg-eng', 'A curator’s own transcript.', null);
		const refused = await poll(curated);
		expect(providerCalls).toBe(1);
		expect(refused.ok, 'the ASR result was saved over an existing transcript').toBe(false);
		expect(langValues((await stored(curated))?.text)).toEqual([
			'lg-eng:A curator’s own transcript.',
		]);
		// the counterfactual: an EMPTY target slice receives the transcript
		const empty = await createSectionRecord(SECTION, USER_ID);
		const filled = await poll(empty);
		expect(providerCalls).toBe(2);
		expect(filled.ok, filled.msg).toBe(true);
		expect(langValues((await stored(empty))?.text).join()).toContain('Machine words.');
	});

	test('TOTALITY: the registered tethers ARE the list the census names — none deleted, none skipped', () => {
		expect([...REGISTERED].sort()).toEqual([...WRITEBACK_TETHER_TITLES].sort());
	});
});
