/**
 * The SINGLE-LANG label contract of the tool element context
 * (buildToolElementContext, src/core/tools/registry.ts).
 *
 * dd1372 stores a tool's labels for every language; the context emits only the
 * entries matching the request's application lang. The client resolver
 * (client/dedalo/core/tools_common/js/tool_common.js get_tool_label) takes a plain name
 * match as already-correct-language BECAUSE of this filter, and falls back to its
 * own call-site literal when a label is absent. If the filter ever widened
 * silently, every tool would start showing labels in a language the user did not
 * ask for; if it ever substituted another lang for a missing one, tools would show
 * mixed languages instead of the intended literal. Stated in that resolver's
 * header, gated here (DEC-12).
 *
 * PHP behaved identically — its responses are frozen in
 * test/parity/fixtures/oracle_harvest/tool_element_context_differential.json,
 * where every emitted label carries the single requested lang (lg-spa).
 *
 * DB-backed. The suite DB's matrix_tools is empty, and the app's registered tools
 * are not a stable corpus, so this seeds its OWN scratch tool row (reserved
 * zz-prefixed name, deleted in afterAll) and asserts against known input.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { translationLangOf } from '../../src/core/resolve/lang_alias.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { TIPO, TOOLS_REGISTER_SECTION_TIPO } from '../../src/core/tools/ontology_map.ts';
import { buildToolElementContext } from '../../src/core/tools/registry.ts';

type LabelEntry = { lang: string; name: string; value: string };

/** Reserved scratch tool name — cannot collide with a real tool_* register. */
const TOOL = 'tool_zz_labels_gate';
const SECTION_ID = 999_701;

/**
 * `shared` is translated in all three langs; `only_cat` exists ONLY in lg-cat, so
 * a request for lg-eng/lg-spa must omit it rather than substitute the Catalan.
 */
const SEEDED: LabelEntry[] = [
	{ lang: 'lg-eng', name: 'shared', value: 'Shared value' },
	{ lang: 'lg-spa', name: 'shared', value: 'Valor compartido' },
	{ lang: 'lg-cat', name: 'shared', value: 'Valor compartit' },
	{ lang: 'lg-eng', name: 'eng_only_extra', value: 'English extra' },
	{ lang: 'lg-spa', name: 'spa_only_extra', value: 'Extra en español' },
	{ lang: 'lg-cat', name: 'only_cat', value: 'Només en català' },
	// a Valencian-own string for ONE key: the alias leg must prefer it over Catalan
	{ lang: 'lg-vlca', name: 'shared', value: 'Valor compartit (valencià)' },
	// …and a Valencian-ONLY key, which Catalan must never read (directional alias)
	{ lang: 'lg-vlca', name: 'only_vlca', value: 'Només en valencià' },
];

const labelsFor = async (lang: string): Promise<LabelEntry[] | undefined> => {
	const context = await runWithRequestLangs({ applicationLang: lang, dataLang: lang }, () =>
		buildToolElementContext(TOOL),
	);
	return context?.labels as LabelEntry[] | undefined;
};

async function cleanScratch(): Promise<void> {
	await sql`
		DELETE FROM matrix_tools
		WHERE section_tipo = ${TOOLS_REGISTER_SECTION_TIPO}
		  AND section_id = ${SECTION_ID}
	`;
}

beforeAll(async () => {
	await cleanScratch();
	// $3/$4 need the ::text::jsonb cast — a bare bind lands as a jsonb STRING
	// scalar, not an object (matrix_write.ts uses the same cast for this reason).
	await sql.unsafe(
		`INSERT INTO matrix_tools (section_tipo, section_id, string, misc)
		 VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)`,
		[
			TOOLS_REGISTER_SECTION_TIPO,
			SECTION_ID,
			encodeForJsonb({ [TIPO.NAME]: [{ id: 1, value: TOOL }] }),
			encodeForJsonb({ [TIPO.LABELS]: [{ id: 1, value: SEEDED }] }),
		],
	);
});

afterAll(cleanScratch);

describe('tool element context: labels are single-lang', () => {
	test('the scratch tool is visible to buildToolElementContext', async () => {
		expect(await labelsFor('lg-eng')).toBeDefined();
	});

	test('emits only the requested lang, and only its keys', async () => {
		expect(await labelsFor('lg-eng')).toEqual([
			{ lang: 'lg-eng', name: 'shared', value: 'Shared value' },
			{ lang: 'lg-eng', name: 'eng_only_extra', value: 'English extra' },
		]);
		expect(await labelsFor('lg-spa')).toEqual([
			{ lang: 'lg-spa', name: 'shared', value: 'Valor compartido' },
			{ lang: 'lg-spa', name: 'spa_only_extra', value: 'Extra en español' },
		]);
	});

	test('a key missing in the requested lang is OMITTED, never served in another lang', async () => {
		for (const lang of ['lg-eng', 'lg-spa']) {
			const names = (await labelsFor(lang))?.map((l) => l.name) ?? [];
			expect({ lang, has_only_cat: names.includes('only_cat') }).toEqual({
				lang,
				has_only_cat: false,
			});
		}
	});

	test('a lang with no entry at all yields an empty array', async () => {
		// The "untranslated" path the client's `|| 'literal'` fallback exists for.
		expect(await labelsFor('lg-zzz')).toEqual([]);
	});
});

describe('tool element context: the declared linguistic ALIAS leg (T2-O11-3)', () => {
	// PHP get_label_lang: a Valencian interface reads the Catalan tool labels —
	// the SAME language under another name (DEDALO_LANG_EQUIVALENCES), so the
	// single-lang contract holds. PHP's further "first stored entry" fallback
	// stays retired (WC-2026-08-02-tool-string-lang-fallback).
	test('precondition: the shipped equivalence declares lg-vlca → lg-cat', () => {
		expect(translationLangOf('lg-vlca')).toBe('lg-cat');
	});

	test('lg-vlca: its own entry first, every other key from lg-cat', async () => {
		expect(await labelsFor('lg-vlca')).toEqual([
			{ lang: 'lg-vlca', name: 'shared', value: 'Valor compartit (valencià)' },
			{ lang: 'lg-vlca', name: 'only_vlca', value: 'Només en valencià' },
			{ lang: 'lg-cat', name: 'only_cat', value: 'Només en català' },
		]);
	});

	test('the alias is DIRECTIONAL: lg-cat never reads lg-vlca, and other langs get no alias', async () => {
		expect(await labelsFor('lg-cat')).toEqual([
			{ lang: 'lg-cat', name: 'shared', value: 'Valor compartit' },
			{ lang: 'lg-cat', name: 'only_cat', value: 'Només en català' },
		]);
		const spanishNames = (await labelsFor('lg-spa'))?.map((l) => l.name) ?? [];
		expect(spanishNames).not.toContain('only_cat');
	});
});
