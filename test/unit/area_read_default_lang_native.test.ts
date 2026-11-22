/**
 * AN AREA READ WITHOUT source.lang RUNS IN THE REQUEST DATA LANG (T2-O15-3a).
 *
 * The three area read behaviors (maintenance, dashboard, tree) defaulted an
 * absent `source.lang` to the literal 'lg-spa' — an install whose data lang is
 * anything else had its area contexts stamped Spanish. The default is now the
 * request's own data lang (resolve/request_lang.ts currentDataLang); an explicit
 * `source.lang` still wins.
 *
 * Outcome asserted: the context entry's `lang`, under TWO request data langs
 * (so a constant cannot pass), for one area of each behavior — picked by MODEL
 * from the engine's own dd areas (no install TLD, no record read).
 */

import { describe, expect, test } from 'bun:test';
import { dispatchAreaRead } from '../../src/core/area/read.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';

/** One area per read behavior: maintenance, dashboard, tree. */
const MODELS = ['area_maintenance', 'area_root', 'area_thesaurus'] as const;
const DATA_LANGS = ['lg-eng', 'lg-cat'] as const;

async function areaOf(model: string): Promise<string> {
	const rows = (await sql`
		SELECT tipo FROM dd_ontology WHERE model = ${model}
		ORDER BY order_number ASC NULLS LAST, tipo COLLATE "C" ASC LIMIT 1
	`) as { tipo: string }[];
	const tipo = rows[0]?.tipo ?? '';
	expect(tipo, `this ontology declares no ${model}`).not.toBe('');
	return tipo;
}

async function contextLang(model: string, dataLang: string, sourceLang?: string): Promise<unknown> {
	const principal = await resolvePrincipal(-1);
	const tipo = await areaOf(model);
	const result = await runWithRequestLangs({ applicationLang: 'lg-eng', dataLang }, () =>
		dispatchAreaRead(
			{
				action: 'read',
				source: {
					tipo,
					section_tipo: tipo,
					model,
					mode: 'list',
					...(sourceLang === undefined ? {} : { lang: sourceLang }),
				},
			} as never,
			principal,
		),
	);
	expect(result?.status).toBe(200);
	const context = (result?.body.data as { context?: { lang?: unknown }[] } | undefined)?.context;
	expect(context?.length ?? 0).toBeGreaterThan(0);
	return context?.[0]?.lang;
}

describe('area read: an absent source.lang is the request data lang (T2-O15-3a)', () => {
	for (const model of MODELS) {
		test(`${model}: the context follows the request data lang`, async () => {
			for (const dataLang of DATA_LANGS) {
				expect(await contextLang(model, dataLang)).toBe(dataLang);
			}
		}, 60000);

		test(`${model}: an explicit source.lang still wins`, async () => {
			expect(await contextLang(model, 'lg-eng', 'lg-cat')).toBe('lg-cat');
		}, 60000);
	}
});
