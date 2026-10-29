/**
 * component_image (rsc29) context + data differential vs the LIVE PHP oracle.
 *
 * Regression gate for the 2026-07-10 component_image review, which found the
 * TS read diverging from PHP on:
 *  - features.allowed_extensions / alternative_extensions (media_features
 *    hardcoded the sample defaults instead of config.media — the install
 *    overrides DEDALO_IMAGE_EXTENSIONS_SUPPORTED/_ALTERNATIVE_EXTENSIONS),
 *  - tools[].tool_config + properties.tool_config ddo_map enrichment (the
 *    'self' sentinels + model/translatable/label — PHP
 *    class.common.php:1868-1916 → tool_common::create_tool_simple_context;
 *    without it the client's tool_common.js builds a synthetic single-entry
 *    ddo_map and tool_transcription never gets its components),
 *  - legacy_model (PHP emits the raw stored model name unconditionally).
 *
 * The DATA layer is asserted as a projection (entry identity + files_info);
 * the blank-image defect itself (SVG envelope served attachment/sandboxed) is
 * gated in test/unit/media_serving.test.ts — it is a header bug, invisible to
 * the JSON wire.
 */
// GENERIC-TLD MIGRATED 2026-08-19 (WC-2026-08-19-test-tld-replay).
// The subject is SEED-SHIPPED ontology — the media section and its
// component_image are part of the ontology every installation ships, so they
// are PINNED, not migrated; they are spelled through `seed()` because the
// install-TLD census reads a literal `rsc170` in a test file as a binding.
// The record and its media files come from the committed corpus (records +
// the media kit), and the frozen PHP interaction is reached through
// `unmapRqo` (fixture lookup) + `adoptTipoIdMap`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { readSection } from '../../src/core/section/read.ts';
import {
	dropTestCorpus,
	ensureMediaKit,
	ensureTestCorpus,
} from '../../src/core/test_data/test_corpus/ensure.ts';
import { adoptTipoIdMap } from './normalize.ts';
import { hasPhpCredentials, PhpApiClient } from './php_client.ts';

/**
 * Seed-shipped ontology, spelled so the install-TLD census does not read it as
 * an install binding (the pilot's `seed()` convention).
 */
const seed = (tld: string, id: number): string => `${tld}${id}`;

/** The seed-shipped media section and its seed-shipped component_image. */
const SECTION = seed('rsc', 170);
const IMAGE = seed('rsc', 29);

const READ_RQO = {
	action: 'read',
	dd_api: 'dd_core_api',
	prevent_lock: true,
	source: {
		typo: 'source',
		type: 'section',
		action: 'search',
		model: 'section',
		tipo: SECTION,
		section_tipo: SECTION,
		section_id: 1,
		mode: 'edit',
		view: null,
		lang: 'lg-spa',
	},
	sqo: {
		section_tipo: [SECTION],
		limit: 1,
		offset: 0,
		filter_by_locators: [{ section_tipo: SECTION, section_id: 1 }],
	},
};

describe.if(hasPhpCredentials())('component_image differential (edit read)', () => {
	let phpContext: Record<string, unknown> | undefined;
	let tsContext: Record<string, unknown> | undefined;
	let phpData: Record<string, unknown> | undefined;
	let tsData: Record<string, unknown> | undefined;

	beforeAll(async () => {
		await ensureTestCorpus([SECTION]);
		// The data projection asserts `file_exist`, so the files the corpus
		// record names must exist under the SUITE media root (which says it is
		// one: `.dedalo_test_media`). ensureMediaKit plants every identity
		// files_info.json names, at the engine's own path grammar.
		await ensureMediaKit();
		const client = new PhpApiClient();
		await client.login(
			config.phpReference.username as string,
			config.phpReference.password as string,
		);
		const { body } = await client.call(structuredClone(READ_RQO));
		// WC-2026-08-19-test-tld-replay: the frozen body is walked through the
		// clone map. Everything this gate names is SEED-shipped ontology, so no
		// tipo needs rewriting to reach the subject — but the frozen edit body
		// also carries the install's own ontology around it (request configs,
		// tool maps), and those DO map, so both counts are non-zero floors.
		const adopted = adoptTipoIdMap(body, 'component_image_context_differential');
		expect(adopted.rewrites.tipos).toBeGreaterThan(0);
		expect(adopted.rewrites.ids).toBeGreaterThan(0);
		// ONE token survives the leftover scan, and it is NOT an address: the
		// uploaded original file name of this very record
		// ("Gemini_Generated_Image_67…ds.png") contains a letter-then-digits run
		// that the `[a-z]+[0-9]+` token grammar cannot tell from a tipo. It is
		// asserted EXACTLY — kind, ONE leftover, and the field it comes from
		// (never spelled: a test file that names an install tipo binds it) — so
		// a real install address appearing here still reddens.
		expect(adopted.kind).toBe('install_tipo_left');
		expect(adopted.leftovers).toHaveLength(1);
		const frozenFileName =
			(
				(body.result as { data: Record<string, unknown>[] }).data.find(
					(item) => item.tipo === IMAGE,
				)?.entries as { original_file_name?: string }[] | undefined
			)?.[0]?.original_file_name ?? '';
		expect(frozenFileName).toContain(adopted.leftovers[0] ?? '');
		const phpResult = adopted.body.result as {
			context: Record<string, unknown>[];
			data: Record<string, unknown>[];
		};
		phpContext = phpResult.context.find((entry) => entry.tipo === IMAGE);
		phpData = phpResult.data.find((item) => item.tipo === IMAGE);
		const tsResult = await readSection(READ_RQO as unknown as Rqo);
		tsContext = (tsResult.context as unknown as Record<string, unknown>[]).find(
			(entry) => entry.tipo === IMAGE,
		);
		tsData = (tsResult.data as unknown as Record<string, unknown>[]).find(
			(item) => item.tipo === IMAGE,
		);
	});

	afterAll(async () => {
		expect(await dropTestCorpus([SECTION])).toBe(0);
	});

	test('media features match the oracle (install-config extensions included)', () => {
		expect(phpContext).toBeDefined();
		expect(tsContext).toBeDefined();
		// The whole features object is the contract — allowed_extensions and
		// alternative_extensions come from the install's DEDALO_IMAGE_* overrides,
		// not the sample defaults.
		expect(tsContext?.features).toEqual(phpContext?.features);
	});

	test('legacy_model is the raw stored model name (emitted unconditionally)', () => {
		expect(tsContext?.legacy_model).toBe(phpContext?.legacy_model as string);
	});

	test('tool_transcription tool_config is enriched on the TOOL context', () => {
		const findTool = (entry: Record<string, unknown> | undefined) =>
			((entry?.tools ?? []) as Record<string, unknown>[]).find(
				(tool) => tool.name === 'tool_transcription',
			);
		const phpTool = findTool(phpContext);
		const tsTool = findTool(tsContext);
		expect(phpTool).toBeDefined();
		expect(tsTool).toBeDefined();
		// The enriched ddo_map ('self' resolved + model/translatable/label) is what
		// the client builds the tool's components from.
		expect(tsTool?.tool_config).toEqual(phpTool?.tool_config);
	});

	test('properties.tool_config mirrors the enrichment (PHP shared-object mutation)', () => {
		const configOf = (entry: Record<string, unknown> | undefined) =>
			((entry?.properties ?? {}) as { tool_config?: Record<string, unknown> }).tool_config
				?.tool_transcription;
		expect(configOf(tsContext)).toEqual(configOf(phpContext));
	});

	test('data entry projection matches (identity + files_info + names)', () => {
		const project = (item: Record<string, unknown> | undefined) => {
			const entries = (item?.entries ?? []) as Record<string, unknown>[];
			return {
				lang: item?.lang,
				external_source: item?.external_source ?? null,
				// WC-2026-10-29-posterframe-url-version: TS versions base_svg_url by file
				// (`?v=<mtime ms>-<size>`); the frozen PHP store has the bare path.
				base_svg_url:
					typeof item?.base_svg_url === 'string'
						? item.base_svg_url.replace(/\?v=\d+-\d+$/, '')
						: (item?.base_svg_url ?? null),
				entries: entries.map((entry) => ({
					id: entry.id,
					original_file_name: entry.original_file_name ?? null,
					files_info: ((entry.files_info ?? []) as Record<string, unknown>[]).map((info) => ({
						quality: info.quality,
						extension: info.extension,
						file_name: info.file_name,
						file_path: info.file_path,
						file_exist: info.file_exist,
					})),
				})),
			};
		};
		expect(phpData).toBeDefined();
		expect(tsData).toBeDefined();
		expect(project(tsData)).toEqual(project(phpData));
	});
});
