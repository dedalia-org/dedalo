/**
 * EXPORT DATA LANG REACHES THE AMBIENT-LANG CELLS — the component_external
 * pin (WC-2026-09-24-tool-export-server-built-artifacts, "get_export_grid").
 *
 * THE CLAIM. An export has ONE data lang: `options.lang` (the tool's selector; the request's data lang when absent).
 * Literal cells always resolved in it (the lang is passed down explicitly).
 * A component_external cell does NOT receive it: relation_list.ts
 * resolveCellValue → deriveExternalValue → external/cache.ts fetchExternalRows
 * reads `currentDataLang()`, the AMBIENT backstop. Until 2026-09-24 that was
 * the session's data lang, so one export mixed two languages (literal cells in
 * `options.lang`, the remote row in the session's). The export now runs every
 * step inside its own scope (grid.ts createExportScope) whose data lang IS the
 * export's, so the remote row follows `options.lang` — in a request, in a
 * detached job (which has no session lang to borrow), and under a contrary
 * ambient scope alike.
 *
 * THE SITUATION IS BUILT. `test3` carries a Zenon api_config and `test215` is
 * a component_external under it. One scratch test3 record (its section_id is
 * the remote id) is inserted; the external row cache is PRIMED for that id in
 * BOTH langs through the subsystem's own facade with an injected socket, each
 * lang answering a different author — so the export itself never leaves the
 * machine, and which author it prints says which lang it fetched in. The
 * primed request URLs are asserted to carry the lang (`lgn=es` / `lgn=en`), so
 * the two cache entries are really per-lang. Swept in afterAll.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { getPropertiesByTipo } from '../../src/core/ontology/resolver.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import type { ToolActionContext } from '../../src/core/tools/module.ts';
import { exportGridUnified, openExportGrid } from '../../src/diffusion/export/index.ts';
import {
	drainInFlightExternalFetches,
	fetchExternalRows,
	parseFieldsMap,
	remoteFieldsOf,
} from '../../src/external/api/index.ts';
import { resetBreakerForOrigin } from '../../src/external/breaker.ts';
import { overrideExternalSettingsForTests } from '../../src/external/settings.ts';

const HOST = 'zenon.dainst.org';
const ORIGIN = `https://${HOST}`;
const SECTION = 'test3';
const TABLE = 'matrix_test';
const EXTERNAL = 'test215'; // component_external, fields_map authors → zenon_authors
const RECORD_ID = 948_901;

const AUTHOR_BY_LANG: Record<string, string> = {
	'lg-spa': 'Autora, Española',
	'lg-eng': 'Author, English',
};

let admin!: Principal;
const primedUrls: string[] = [];

async function prime(dataLang: string): Promise<void> {
	const properties = (await getPropertiesByTipo(EXTERNAL)) as { fields_map?: unknown } | null;
	const remoteFields = remoteFieldsOf(parseFieldsMap(properties?.fields_map, { tipo: EXTERNAL }));
	const author = AUTHOR_BY_LANG[dataLang] as string;
	const views = await fetchExternalRows(
		[{ sectionTipo: SECTION, remoteId: String(RECORD_ID), remoteFields }],
		{
			dataLang,
			deps: {
				fetchImpl: async (input: unknown) => {
					primedUrls.push(String(input instanceof Request ? input.url : input));
					return new Response(
						JSON.stringify({
							records: [{ id: String(RECORD_ID), authors: { primary: { [author]: {} } } }],
							status: 'OK',
						}),
						{ status: 200 },
					);
				},
				assertPublicUrlImpl: async (uri: string) => ({
					url: new URL(uri),
					addresses: ['141.100.1.1'],
				}),
			},
		},
	);
	expect([...views.values()][0]?.status).toBe('ok');
}

async function sweep(): Promise<void> {
	await deleteMatrixRecord(TABLE, SECTION, RECORD_ID);
	await sql.unsafe('DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2', [
		SECTION,
		RECORD_ID,
	]);
}

beforeAll(async () => {
	await assertTestDatabase('export_external_data_lang_native');
	await sweep();
	await sql.unsafe(
		`INSERT INTO "${TABLE}" ("section_tipo", "section_id", "string") VALUES ($1, $2, $3::text::jsonb)`,
		[SECTION, RECORD_ID, encodeForJsonb({})],
	);
	overrideExternalSettingsForTests({
		enabled: true,
		disabledServices: [],
		allowedHosts: [HOST],
		softTtlMs: 3_600_000,
		retryAttempts: 0,
		maxConcurrency: 4,
	});
	resetBreakerForOrigin('zenon', ORIGIN);
	await clearOntologyDerivedCaches();
	admin = await resolvePrincipal(-1);
	await prime('lg-spa');
	await prime('lg-eng');
});

afterAll(async () => {
	overrideExternalSettingsForTests(null);
	await drainInFlightExternalFetches();
	resetBreakerForOrigin('zenon', ORIGIN);
	await clearOntologyDerivedCaches();
	await assertTestDatabase('export_external_data_lang_native');
	await sweep();
});

const exportOptions = (lang: string | undefined) => ({
	section_tipo: SECTION,
	data_format: 'value',
	breakdown: 'rows',
	...(lang === undefined ? {} : { lang }),
	ar_ddo_to_export: [
		{ path: [{ section_tipo: SECTION, component_tipo: EXTERNAL, name: EXTERNAL }] },
	],
	sqo: {
		section_tipo: [SECTION],
		filter_by_locators: [{ section_tipo: SECTION, section_id: RECORD_ID }],
	},
});

/** The stream-mode get_export_grid, run under a SESSION data lang. */
async function streamUnderSession(
	sessionDataLang: string,
	lang: string | undefined,
): Promise<string> {
	return runWithRequestContext(
		{ principal: admin, session: null, requestId: 'zzextlang', clientIp: '' },
		() =>
			runWithRequestLangs({ applicationLang: 'lg-eng', dataLang: sessionDataLang }, async () => {
				const response = (await exportGridUnified({
					principal: admin,
					userId: -1,
					background: false,
					options: { ...exportOptions(lang), ndjson_stream: true },
				} as ToolActionContext)) as unknown as { ok: boolean; stream: ReadableStream<Uint8Array> };
				expect(response.ok).toBe(true);
				return new Response(response.stream).text();
			}),
	);
}

describe('the export data lang reaches the component_external cell', () => {
	test('the primed cache really holds one row PER lang', () => {
		expect(primedUrls.some((url) => url.includes('lgn=es'))).toBe(true);
		expect(primedUrls.some((url) => url.includes('lgn=en'))).toBe(true);
	});

	test('options.lang wins over the session data lang (both directions)', async () => {
		const spa = await streamUnderSession('lg-eng', 'lg-spa');
		expect(spa).toContain('Autora, Española');
		expect(spa).not.toContain('Author, English');

		const eng = await streamUnderSession('lg-spa', 'lg-eng');
		expect(eng).toContain('Author, English');
		expect(eng).not.toContain('Autora, Española');
	});

	test("no options.lang = the request's data lang, never a hardcoded install lang", async () => {
		// The build handler always sends options.lang (withExportLang); a producer
		// call without it takes the request-scoped data lang, not 'lg-spa'.
		const text = await streamUnderSession('lg-eng', undefined);
		expect(text).toContain('Author, English');
		expect(text).not.toContain('Autora, Española');
	});

	test('a detached producer (no session at all) gives the same bytes', async () => {
		const opened = await openExportGrid({
			principal: admin,
			options: exportOptions('lg-spa'),
			applicationLang: 'lg-eng',
		});
		const lines: string[] = [];
		for await (const line of opened.lines) lines.push(JSON.stringify(line));
		const inRequest = (await streamUnderSession('lg-eng', 'lg-spa'))
			.split('\n')
			.filter((line) => line !== '');
		expect(lines).toEqual(inRequest);
	});
});
