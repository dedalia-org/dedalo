/**
 * R3 gate: tool_lang / tool_lang_multi automatic_translation. The read→translate
 * item logic is verified with a STUB provider (the plan's external-engine gate);
 * quota/failure short-circuits are checked; both modules load and share the core.
 * The real Babel HTTP call + the DB write drive are ledgered (external engine).
 */
// Migrated to the generic `test` TLD 2026-08-19: the translated component is an opaque
// input_text tipo, so it now names the generic `test52`.

import { describe, expect, test } from 'bun:test';
import { readTranslationCatalog } from '../../scripts/lib/ai_model_register.ts';
import { pinnedRevision } from '../../src/core/ai/model_pins.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import { buildToolElementContext } from '../../src/core/tools/registry.ts';
import {
	babelDirection,
	resolveTranslationProvider,
	resolveTranslatorConfig,
	runAutomaticTranslation,
	type TranslationProvider,
	translateItems,
} from '../../src/core/tools/translation.ts';
import { mustGet } from '../helpers/assert.ts';

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const NO_ACCESS: Principal = { userId: 999999, isGlobalAdmin: false, isDeveloper: false };

const cfg = { uri: 'https://tr.example.org', key: 'k', sourceLang: 'lg-eng', targetLang: 'lg-spa' };

/** A stub that upper-cases + tags each text so we can assert per-item mapping. */
const upperStub: TranslationProvider = async (req) => ({
	ok: true,
	text: `[${req.text.toUpperCase()}]`,
	msg: 'ok',
});

describe('translateItems (stub provider)', () => {
	test('maps each source item value → target-lang item, preserving order', async () => {
		const out = await translateItems(
			[
				{ value: 'cat', lang: 'lg-eng' },
				{ value: 'dog', lang: 'lg-eng' },
			],
			upperStub,
			cfg,
		);
		expect(out.error).toBeNull();
		expect(out.items).toEqual([
			{ value: '[CAT]', lang: 'lg-spa' },
			{ value: '[DOG]', lang: 'lg-spa' },
		]);
	});

	test('a target item keeps its SOURCE item id (item N translated is item N); no id is invented', async () => {
		const out = await translateItems(
			[
				{ id: 1, value: 'cat', lang: 'lg-eng' },
				{ value: 'dog', lang: 'lg-eng' },
			],
			upperStub,
			cfg,
		);
		expect(out.items).toEqual([
			{ id: 1, value: '[CAT]', lang: 'lg-spa' },
			{ value: '[DOG]', lang: 'lg-spa' },
		]);
		expect('id' in (out.items[1] ?? {})).toBe(false);
	});

	test('provider failure short-circuits with the error', async () => {
		const failStub: TranslationProvider = async () => ({ ok: false, msg: 'boom' });
		const out = await translateItems([{ value: 'x' }], failStub, cfg);
		expect(out).toEqual({ items: [], error: 'boom' });
	});

	test('an EMPTY result for a source with text is refused (unsupported pair); a blank source is not', async () => {
		const emptyStub: TranslationProvider = async () => ({ ok: true, text: ' <p></p> ', msg: 'ok' });
		const out = await translateItems([{ value: '<p>Visto MAN</p>' }], emptyStub, cfg);
		expect(out.items).toEqual([]);
		expect(out.emptyResult).toBe(true);
		const blank = await translateItems([{ value: '<p> </p>' }], emptyStub, cfg);
		expect(blank.error).toBeNull();
		expect(blank.items).toHaveLength(1);
	});

	test('quota-exceeded result is treated as an error (never persisted)', async () => {
		const quotaStub: TranslationProvider = async () => ({
			ok: true,
			text: 'Sorry. Quota exceeded today',
			msg: 'ok',
		});
		const out = await translateItems([{ value: 'x' }], quotaStub, cfg);
		expect(out.error).toBe('Sorry. Quota exceeded');
	});
});

describe('translation helpers', () => {
	// The golden moved on 2026-08: this used to expect 'spa-eng' (a whole-ISO-code
	// join). The ORACLE is babel::get_babel_direction —
	// tools/tool_lang/translators/class.babel.php:190-201 — which does
	// `substr($lang, 3, 2)`, i.e. the FIRST TWO letters of the ISO code, so
	// ('lg-spa','lg-eng') → 'sp-en' (Apertium mode names). 'spa-eng' names a mode
	// the box does not have, which is how the `Error: Mode …` bodies audit §5.6
	// found written over target-language slots were produced. Exhaustive cases
	// (malformed lang, German as TARGET) live in translation_pipeline_native.test.ts.
	test('babelDirection takes the first TWO letters of each ISO code (PHP substr 3,2)', () => {
		expect(babelDirection('lg-spa', 'lg-eng')).toBe('sp-en');
	});
	test('babelDirection: the German SOURCE exception keeps the full three-letter codes', () => {
		// class.babel.php:194-199 — 'lg-deu' source → 'deu'; the target is
		// reassigned to 'eng' ONLY when it is English, else generic extraction.
		expect(babelDirection('lg-deu', 'lg-eng')).toBe('deu-eng');
		expect(babelDirection('lg-deu', 'lg-spa')).toBe('deu-sp');
	});
	test('resolveTranslationProvider: babel default, browser/google rejected', () => {
		expect(resolveTranslationProvider('babel').provider).not.toBeNull();
		expect(resolveTranslationProvider('browser_transformer').provider).toBeNull();
		expect(resolveTranslationProvider('google_translation').error).toContain('not implemented');
	});
	test('resolveTranslatorConfig finds the engine entry by name', () => {
		const toolConfig = {
			config: { translator_config: { value: [{ name: 'babel', uri: 'u', key: 'k' }] } },
		};
		expect(resolveTranslatorConfig(toolConfig, 'babel')).toEqual({ uri: 'u', key: 'k' });
		expect(resolveTranslatorConfig(toolConfig, 'missing')).toBeNull();
		expect(resolveTranslatorConfig({}, 'babel')).toBeNull();
	});
});

describe('runAutomaticTranslation — gates and loud failures', () => {
	/**
	 * The DedaloError a run threw, or null when it returned an envelope. P1 error
	 * sweep: every gate here REFUSES BY THROWING a registered code (the tool
	 * dispatch chokepoint converts it), so the assertions are on the CODE.
	 */
	async function refusalOf(
		run: () => Promise<unknown>,
	): Promise<{ code: string; message: string; publicMessage?: string } | null> {
		try {
			await run();
			return null;
		} catch (error) {
			return isDedaloError(error)
				? { code: error.code, message: error.message, publicMessage: error.publicMessage }
				: null;
		}
	}

	const options = {
		component_tipo: 'test52',
		section_tipo: 'test2',
		section_id: 905301,
		source_lang: 'lg-eng',
		target_lang: 'lg-spa',
	};

	test('missing required parameters are refused', async () => {
		for (const bad of [{ target_lang: '' }, { component_tipo: '' }, { section_tipo: '' }]) {
			const refusal = await refusalOf(() =>
				runAutomaticTranslation(
					{ options: { ...options, ...bad }, userId: -1, principal: SUPERUSER },
					'tool_lang',
				),
			);
			expect(refusal?.code).toBe('request.invalid_options');
			// request.invalid_options is public-disclosure: the sentence reaches the wire.
			expect(refusal?.publicMessage).toContain('Missing required parameters');
		}
	});

	test('an ungranted caller is refused outright', async () => {
		const refusal = await refusalOf(() =>
			runAutomaticTranslation({ options, userId: 999999, principal: NO_ACCESS }, 'tool_lang'),
		);
		expect(refusal?.code).toBe('perm.denied');
	});

	// The (section_tipo, component_tipo) WRITE PAIR — the half PHP asserted and the
	// port once dropped — is the WRITE DOOR's (closure Step 3 req 10): it is driven
	// with REAL identities, no mock, by authz_door_matrix_native's
	// tool:tool_lang:automatic_translation cells (NO_COMPONENT, READ_COMPONENT,
	// DD1725 — refused ON the component), not here.
	test('a malformed record id is a grammar refusal, never record 0 (the write door)', async () => {
		for (const section_id of [undefined, 1.5, 'abc']) {
			const refusal = await refusalOf(() =>
				runAutomaticTranslation(
					{ options: { ...options, section_id }, userId: -1, principal: SUPERUSER },
					'tool_lang',
				),
			);
			expect(refusal?.code).toBe('request.invalid');
		}
	});

	test('a client-side-only or unimplemented engine FAILS LOUDLY (never empty output)', async () => {
		for (const [translator, fragment] of [
			['browser_transformer', 'client-side only'],
			['google_translation', 'not implemented'],
		] as const) {
			const refusal = await refusalOf(() =>
				runAutomaticTranslation(
					{ options: { ...options, translator }, userId: -1, principal: SUPERUSER },
					'tool_lang',
				),
			);
			expect(refusal?.code).toBe('request.invalid_options');
			expect(refusal?.publicMessage).toContain(fragment);
		}
	});

	test('an unconfigured backend is reported, never silently skipped', async () => {
		// Either the install has no translator_config for this engine (the
		// common case → the explicit config error) or it has one and the run
		// stops at the empty source slice — never a fabricated translation.
		const outcome = await runAutomaticTranslation(
			{ options: { ...options, translator: 'babel' }, userId: -1, principal: SUPERUSER },
			'tool_lang',
		).then(
			(envelope) => ({ envelope, error: null as unknown }),
			(error: unknown) => ({ envelope: null, error }),
		);
		if (outcome.envelope === null) {
			expect(isDedaloError(outcome.error)).toBe(true);
			expect((outcome.error as { code: string }).code).toBe('translation.not_configured');
			expect(String((outcome.error as Error).message)).toContain('Translator config');
		} else {
			expect(outcome.envelope.msg).toBe('Ignored empty result. Nothing is saved!');
			expect(outcome.envelope.count).toBe(0);
		}
	});
});

/**
 * C54 LIFTED (2026-11-22; owner 2026-11-13, T1-P01 16a/16b): tool_lang_multi is
 * served tool_lang's client config (configFrom, RATIFIED) WHOLE — the
 * `type:'browser'` translator engine, hidden from translate-all "until the
 * translategemma revision is pinned", is served again now that it is. Measured
 * on the SERVED element context — the one thing the client reads
 * (render_tool_lang_multi.js `context.config.translator_engine.value`). The
 * lift is bound to its recorded condition: the gate also asserts that every
 * model of the served browser engine's catalogue, translategemma included, is
 * pinned — so the engine cannot be served to translate-all against unpinned
 * models. tool_lang serving a browser engine at all is the positive control: a
 * run where tool_lang served none would prove nothing, and fails here.
 */
describe('tool_lang_multi context serves the browser engine (C54 lifted)', () => {
	type Engine = { name: string; type: string; models?: { model_id?: string }[] };
	const servedEngines = async (tool: string): Promise<Engine[]> => {
		const context = await runWithRequestLangs(
			{ applicationLang: 'lg-eng', dataLang: 'lg-eng' },
			() => buildToolElementContext(tool),
		);
		expect(context).not.toBeNull();
		const config = (context as { config?: Record<string, unknown> }).config;
		expect(config).toBeDefined();
		const engine = (config as Record<string, unknown>).translator_engine as { value: Engine[] };
		expect(Array.isArray(engine?.value)).toBe(true);
		return engine.value;
	};

	test('tool_lang serves every engine, browser included (positive control)', async () => {
		const engines = await servedEngines('tool_lang');
		expect(engines.some((e) => e.type === 'browser')).toBe(true);
		expect(engines.some((e) => e.type === 'server')).toBe(true);
	});

	test("tool_lang_multi serves tool_lang's engines WITH the browser one; the whole config is identical", async () => {
		const lang = await servedEngines('tool_lang');
		const multi = await servedEngines('tool_lang_multi');
		expect(multi.some((e) => e.type === 'browser')).toBe(true);
		expect(multi).toEqual(lang);
		const configOf = async (tool: string): Promise<Record<string, unknown>> =>
			(
				(await runWithRequestLangs({ applicationLang: 'lg-eng', dataLang: 'lg-eng' }, () =>
					buildToolElementContext(tool),
				)) as { config: Record<string, unknown> }
			).config;
		expect(await configOf('tool_lang_multi')).toEqual(await configOf('tool_lang'));
	});

	test("the lift's condition holds: translategemma and every catalogue translator are pinned", async () => {
		// The SHIPPED catalogue (tools/tool_lang/register.json, what an install
		// registers): translategemma is in it and every translator is pinned.
		const translators = readTranslationCatalog();
		expect(translators.map((entry) => entry.id)).toContain(
			'onnx-community/translategemma-text-4b-it-ONNX',
		);
		for (const entry of translators) expect(pinnedRevision(entry.id), entry.id).not.toBeNull();
		// And whatever catalogue the SERVED engine carries (a registry imported
		// before 2026-11-22 carries none): every model it names is pinned — a
		// templated id through its recorded expansion.
		const browser = (await servedEngines('tool_lang_multi')).filter((e) => e.type === 'browser');
		for (const model of browser.flatMap((engine) => engine.models ?? [])) {
			const id = String(model.model_id);
			const concrete = /\{src\}|\{tgt\}/.test(id)
				? translators.filter((entry) => entry.template === id).map((entry) => entry.id)
				: [id];
			expect(concrete.length, `${id}: no pinned model`).toBeGreaterThan(0);
			for (const entry of concrete) expect(pinnedRevision(entry), entry).not.toBeNull();
		}
	});
});

describe('tool_lang / tool_lang_multi modules', () => {
	test('both load with the automatic_translation action', async () => {
		for (const name of ['tool_lang', 'tool_lang_multi']) {
			const loaded = await getLoadedTool(name);
			expect(loaded).not.toBeNull();
			expect(Object.keys(loaded!.module.apiActions)).toEqual(['automatic_translation']);
			expect(
				mustGet(loaded!.module.apiActions.automatic_translation, 'automatic_translation')
					.permission,
			).toBeNull();
		}
	});
});

/**
 * REGRESSION GATE (2026-07-28): resolveTranslatorConfig must read the shape
 * getToolConfig ACTUALLY emits.
 *
 * getToolConfig resolves options FLAT (one key per option), so `tool_lang`'s
 * config comes back as {info, translator_config, translator_engine} with NO
 * `.config` wrapper. The resolver read `toolConfig.config.translator_config.value`
 * — a shape no DB record, no register.json and no caller ever produces — so it
 * returned null for every engine and EVERY automatic_translation request failed
 * with "Translator config (uri/key) is not defined". The pre-existing tests fed
 * the nested shape by hand, so they stayed green while the feature was dead.
 * This is the identical bug that was fixed one function over in
 * transcription_asr.ts; the fix mirrors it (flat first, nested tolerated).
 */
describe('resolveTranslatorConfig reads the real getToolConfig shape', () => {
	const entry = { name: 'babel', uri: 'https://tr.example.org', key: 'k' };

	test('the FLAT shape getToolConfig emits resolves', () => {
		expect(resolveTranslatorConfig({ translator_config: [entry] }, 'babel')).toEqual({
			uri: entry.uri,
			key: entry.key,
		});
	});

	test('an un-unwrapped {value:[…]} under the flat key resolves', () => {
		expect(resolveTranslatorConfig({ translator_config: { value: [entry] } }, 'babel')).toEqual({
			uri: entry.uri,
			key: entry.key,
		});
	});

	test('the legacy nested shape still resolves (tolerated, not required)', () => {
		expect(
			resolveTranslatorConfig({ config: { translator_config: { value: [entry] } } }, 'babel'),
		).toEqual({ uri: entry.uri, key: entry.key });
	});

	test('an unknown engine is still null', () => {
		expect(resolveTranslatorConfig({ translator_config: [entry] }, 'google')).toBeNull();
	});
});
