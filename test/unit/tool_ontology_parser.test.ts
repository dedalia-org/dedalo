/**
 * Gate: tool_ontology_parser — the module contract, the developer gate on every
 * action, and the two READ wires the client renders.
 *
 * `test/unit/ontology_data_io.test.ts` already covers the export pipeline's
 * ordering/abort semantics with an injected IO. What was untested is the part a
 * user actually touches first: the ACTION SURFACE (five developer-gated actions,
 * none background-runnable — `reconcile_ontologies` was removed 2026-08-11, leaving
 * `regenerate_ontologies` the ONE write onto the projection) and the two reads —
 *
 *  - get_ontologies      → the census the tool's checkbox list is built from.
 *    Its wire is EXACTLY five keys; adding a sixth leaks census internals
 *    (name_data) to the browser, dropping one blanks a column.
 *  - inspect_ontologies  → `states[]`, which render_tool_ontology_parser.js reads
 *    as `state.inSync` / `state.matrixNodes` / `state.mainNodeOk` /
 *    `state.drift[].kind`. A renamed field renders "Status unavailable".
 *
 * Both reads are pure: this file writes nothing.
 */

import { describe, expect, test } from 'bun:test';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getLoadedTool } from '../../src/core/tools/loader.ts';
import type { ToolActionContext, ToolActionSpec } from '../../src/core/tools/module.ts';
import { mustGet } from '../helpers/assert.ts';
import { refusalOf } from '../helpers/refusal.ts';

const DEVELOPER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const PLAIN_USER: Principal = { userId: 99, isGlobalAdmin: false, isDeveloper: false };

const ACTIONS = [
	'export_ontologies',
	'get_ontologies',
	'inspect_ontologies',
	'regenerate_ontologies',
	// The one action that writes SOURCE records: it rewrites a misfiled ontology7
	// back to its section's tld (ONT-TLD), the repair the read-only edit field removed.
	'repair_tlds',
];

function ctx(principal: Principal, options: Record<string, unknown> = {}): ToolActionContext {
	return { principal, userId: principal.userId, options, background: false };
}

async function action(name: string): Promise<ToolActionSpec> {
	const loaded = await getLoadedTool('tool_ontology_parser');
	expect(loaded).not.toBeNull();
	return mustGet(loaded!.module.apiActions[name], name);
}

describe('tool_ontology_parser module', () => {
	test('registers the five actions, all developer-gated, none background-runnable', async () => {
		const loaded = await getLoadedTool('tool_ontology_parser');
		expect(loaded).not.toBeNull();
		const actions = loaded!.module.apiActions;
		expect(Object.keys(actions).sort()).toEqual(ACTIONS);
		for (const name of ACTIONS) {
			expect(mustGet(actions[name], name).permission).toBe('developer');
		}
		expect(loaded!.module.backgroundRunnable).toBeUndefined();
	});

	test('every action refuses a non-developer even with the dispatch gate bypassed', async () => {
		// Defence in depth (PHP assert_developer): the declarative spec is the
		// framework gate, the in-handler check is the second lock. Two of these
		// actions WRITE the runtime ontology, so both locks must hold on their own.
		for (const name of ACTIONS) {
			const refusal = await refusalOf(
				(await action(name)).handler(ctx(PLAIN_USER, { selected_ontologies: ['test'] })),
			);
			expect(refusal.code).toBe('perm.developer_required');
		}
	});

	test('get_ontologies emits EXACTLY the five UI metadata fields', async () => {
		const res = await (await action('get_ontologies')).handler(ctx(DEVELOPER));
		expect(res.ok).toBe(true);
		// `data` IS the flat census (the client `.find`s on response_data); the
		// per-ontology notes ride as the `errors` EXTENSION key (ERRORS_SPEC §3.0).
		const list = res.data as Record<string, unknown>[];
		expect(Array.isArray(list)).toBe(true);
		expect(Array.isArray((res as { errors?: unknown }).errors)).toBe(true);
		expect(list.length).toBeGreaterThan(0);
		for (const entry of list) {
			expect(Object.keys(entry).sort()).toEqual([
				'name',
				'target_section_tipo',
				'tld',
				'typology_id',
				'typology_name',
			]);
		}
		// The census is the source of the checkbox list — the core TLDs are in it.
		const tlds = list.map((entry) => entry.tld);
		expect(tlds).toContain('dd');
		expect(tlds).toContain('test');
	});

	test('inspect_ontologies is a READ that returns one state per requested tld', async () => {
		const res = await (await action('inspect_ontologies')).handler(
			ctx(DEVELOPER, { selected_ontologies: ['test', 'dd'] }),
		);
		expect(res.ok).toBe(true);
		const states = (res.data as { states: Record<string, unknown>[] }).states;
		expect(Array.isArray(states)).toBe(true);
		expect(states.length).toBe(2);
		// The exact keys render_tool_ontology_parser.js reads off each state.
		for (const state of states) {
			for (const key of [
				'tld',
				'matrixNodes',
				'storedNodes',
				'mainNodeOk',
				'drift',
				'inSync',
				'tldlessNodes',
				'modelRuleViolations',
			]) {
				expect(key in state).toBe(true);
			}
			expect(Array.isArray(state.drift)).toBe(true);
			// The model-rule warning channel (render_model_rule_note reads it as an array).
			expect(Array.isArray(state.modelRuleViolations)).toBe(true);
			// storedNodes counts the bootstrap <tld>0 main node, which is NOT parsed
			// from a matrix record — so a healthy tld is matrixNodes + 1, and reading
			// the difference as drift would be wrong.
			expect(state.mainNodeOk).toBe(true);
			if (state.inSync === true) {
				expect(state.storedNodes).toBe((state.matrixNodes as number) + 1);
				expect((state.drift as unknown[]).length).toBe(0);
			}
		}
		// Every drift entry is one of the three kinds the client counts.
		for (const state of states) {
			for (const item of state.drift as { kind: string; tipo: string; diffColumns: string[] }[]) {
				expect(['missing', 'stale', 'orphaned']).toContain(item.kind);
				expect(typeof item.tipo).toBe('string');
				expect(Array.isArray(item.diffColumns)).toBe(true);
			}
		}
	});

	test('inspect_ontologies on a malformed tld reports not-in-sync instead of throwing', async () => {
		// safeTld is /^[a-z]{2,}$/ — the panel must render a failed check, not a 500.
		const res = await (await action('inspect_ontologies')).handler(
			ctx(DEVELOPER, { selected_ontologies: ['9x', 'DD;DROP'] }),
		);
		expect(res.ok).toBe(true);
		const states = (res.data as { states: Record<string, unknown>[] }).states;
		expect(states.length).toBe(2);
		for (const state of states) {
			expect(state.tld).toBeNull();
			expect(state.inSync).toBe(false);
			expect(state.matrixNodes).toBe(0);
		}
	});

	test('inspect_ontologies with no selection is an empty read, not a whole-install sweep', async () => {
		const res = await (await action('inspect_ontologies')).handler(ctx(DEVELOPER, {}));
		expect(res.ok).toBe(true);
		expect((res.data as { states: unknown }).states).toEqual([]);
	});

	test('export_ontologies refuses an absent or empty selection (PHP parity)', async () => {
		for (const options of [{}, { selected_ontologies: [] }, { selected_ontologies: null }]) {
			const refusal = await refusalOf(
				(await action('export_ontologies')).handler(ctx(DEVELOPER, options)),
			);
			expect(refusal.code).toBe('request.invalid_options');
			expect(refusal.publicMessage).toBe('selected_ontologies must be a non-empty array');
		}
	});

	/**
	 * WC-2026-08-11-regenerate-drops-llm-map-post-step. PHP ran `export_llm_map` after the
	 * dd_ontology write and merged its errors in. The map is a DISTRIBUTION artifact whose
	 * companions (`ontology.json`, the per-TLD dumps) a regenerate does not refresh either,
	 * and building it walks the WHOLE install: 21.2s of a measured 22.1s request on
	 * dedalo7_mht, against 76ms for the parse+diff of the TLD actually asked for.
	 *
	 * Asserted against the SOURCE because the regression is a re-added call, not a wrong
	 * value — a response-shape assertion cannot see the 21 seconds. The export handler is
	 * read in the same pass so this can never pass by the map having left the file entirely:
	 * `export_ontologies` must still be its one caller (its always-runs/errors-merged
	 * semantics stay gated by `ontology_data_io.test.ts`).
	 */
	test('regenerate_ontologies does NOT rebuild the LLM map; export_ontologies still does', async () => {
		const source = await Bun.file(
			`${import.meta.dir}/../../tools/tool_ontology_parser/server/tool_ontology_parser.ts`,
		).text();

		const body = (fnName: string): string => {
			const start = source.indexOf(`export async function ${fnName}(`);
			expect(start).toBeGreaterThan(-1);
			const next = source.indexOf('\nexport ', start + 1);
			return source.slice(start, next === -1 ? source.length : next);
		};

		// The regenerate handler reaches nothing llm-map shaped (call or wrapper).
		expect(body('toolOntologyParserRegenerate')).not.toMatch(/[Ll]lmMap\s*\(/);
		// …and the export pipeline still runs it.
		expect(body('runExportOntologies')).toMatch(/io\.exportLlmMap\s*\(/);
	});
});

/**
 * Gate: the tool's UI strings. Every `get_tool_label('x')` the client calls must exist in the
 * register SEED, in every language the seed already speaks.
 *
 * Without this the failure is silent and slow: the JS `|| 'literal'` fallback means a label
 * missing from the seed still RENDERS — in English — for every operator on the install, and
 * nothing fails until someone notices one control is not translated. The client is the source
 * of demand here, so the key list is extracted from it rather than restated.
 */
describe('tool_ontology_parser labels', () => {
	const TOOL_DIR = `${import.meta.dir}/../../tools/tool_ontology_parser`;
	const LABELS_TIPO = 'dd1372';

	type LabelItem = { lang: string; name: string; value: string };

	async function seedLabels(): Promise<LabelItem[]> {
		const register = JSON.parse(await Bun.file(`${TOOL_DIR}/register.json`).text());
		const value = register.misc?.[LABELS_TIPO]?.[0]?.value;
		expect(Array.isArray(value)).toBe(true);
		return value as LabelItem[];
	}

	/** The label keys the client actually asks for, read off the tool's own JS. */
	async function requestedKeys(): Promise<string[]> {
		const files = ['js/render_tool_ontology_parser.js', 'js/tool_ontology_parser.js'];
		const keys = new Set<string>();
		for (const file of files) {
			const source = await Bun.file(`${TOOL_DIR}/${file}`).text();
			for (const match of source.matchAll(/get_tool_label\(\s*'([^']+)'\s*\)/g)) {
				keys.add(mustGet(match[1], 'label key'));
			}
		}
		return [...keys].sort();
	}

	test('every label the client asks for is in the seed', async () => {
		const labels = await seedLabels();
		const defined = new Set(labels.map((item) => item.name));
		const missing = (await requestedKeys()).filter((key) => !defined.has(key));
		expect(missing).toEqual([]);
	});

	test('every label is translated into every language the seed speaks', async () => {
		const labels = await seedLabels();
		const langs = [...new Set(labels.map((item) => item.lang))].sort();
		expect(langs.length).toBeGreaterThan(1); // guard: a one-lang seed would pass vacuously

		const byName = new Map<string, Set<string>>();
		for (const item of labels) {
			const langsForName = byName.get(item.name) ?? new Set<string>();
			langsForName.add(item.lang);
			byName.set(item.name, langsForName);
		}

		const gaps = [...byName.entries()]
			.map(([name, present]) => ({ name, missing: langs.filter((lang) => !present.has(lang)) }))
			.filter((entry) => entry.missing.length > 0);
		expect(gaps).toEqual([]);
	});

	test('no label is defined twice for the same language', async () => {
		const labels = await seedLabels();
		const seen = new Set<string>();
		const duplicates: string[] = [];
		for (const item of labels) {
			const key = `${item.name}/${item.lang}`;
			if (seen.has(key)) duplicates.push(key);
			seen.add(key);
		}
		expect(duplicates).toEqual([]);
	});
});
