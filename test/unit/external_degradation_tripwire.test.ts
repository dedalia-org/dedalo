/**
 * EXTERNAL DEGRADATION tripwire (DEC-12: every stated invariant gets a
 * mechanical gate).
 *
 * THE INVARIANT, in one line: **a component_external never emits a silent
 * blank.** Either it has values, or it says why it does not.
 *
 * That rule is easy to state and easy to erode — one `return []` on a new
 * failure branch, one `catch {}`, one label written as prose instead of a
 * catalog key, and the record shows an empty field that a cataloguer will read
 * as "this work has no author". v6 eroded it completely: every failure emitted
 * nothing. So this gate asserts it three ways, and each way is there because it
 * catches something the others cannot:
 *
 *  1. BEHAVIOUR — every reachable state emits an item whose `entries` is a
 *     string array, never `null` and never `[null]`, and every non-'ok' state
 *     carries `source_status`;
 *  2. TOTALITY — the state → label_key / retryable maps cover the whole closed
 *     state set, and every label_key they name EXISTS in the labels master (a
 *     wire field pointing at an undefined key renders as nothing at all);
 *  3. SOURCE — the derivation and emission modules contain no blank-emitting
 *     shape (`entries: null`, `[null]`, an empty catch), and the TEST-ONLY
 *     transport seam has no production caller.
 *
 * DB-less except for the ontology reads the derivation makes against the
 * canonical `test3` playground; nothing is written.
 */
// Migrated to the generic `test` TLD 2026-08-19: the "ordinary, non-external section"
// coordinate is now `test2` (test3 IS external here — it carries test215) and the
// external section named in the refused import cell is the generic clone `test7342`
// (src/core/test_data/test_tld_tipo_map.json).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import {
	deriveExternalValue,
	EXTERNAL_STATE_LABEL_KEY,
	EXTERNAL_STATE_RETRYABLE,
	type ExternalSourceState,
	externalSourceStatus,
	setPrefetchedExternalRows,
	stateForKind,
} from '../../src/core/components/component_external/value.ts';
import { getEmitHook } from '../../src/core/components/emit_hooks.ts';
import { getComponentModel } from '../../src/core/components/registry.ts';
import type { Ddo } from '../../src/core/concepts/ddo.ts';
import type { MatrixRecord } from '../../src/core/db/matrix.ts';
import labelsMaster from '../../src/core/labels/master.json';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { type DataItem, EmissionContext } from '../../src/core/resolve/component_data.ts';
import { dropSituation, ensureSituation } from '../../src/core/test_data/situations/situation.ts';
import type { ExternalErrorKind, ExternalRowView } from '../../src/external/api/types.ts';
import { overrideExternalSettingsForTests } from '../../src/external/settings.ts';
import {
	UNBOUND_COMPONENT,
	UNBOUND_EXTERNAL_SITUATION,
	UNBOUND_SECTION,
} from '../helpers/external_unbound_situation.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SECTION = 'test3';
const COMPONENT = 'test215';
const REMOTE_ID = '000848571';

/**
 * The closed state set, restated so ADDING a state fails here until it is mapped.
 *
 * TYPE-LEVEL TOTALITY (2026-09-02, P2-20/S-3): the old annotation
 * `readonly ExternalSourceState[]` let a SUBSET type-check — a ninth state added
 * to the union would have compiled here unlisted, and every "covers the closed
 * set" assertion below would have passed over eight. `as const satisfies` keeps
 * the literal element type, and `MissingState` is `never` exactly when the list
 * IS the union: adding a state to `ExternalSourceState` without adding it here
 * fails `tsc` on the line that pins `MissingState` to never. This is the
 * closed-set exemption `census_derivation_tripwire` names for this file.
 */
const ALL_STATES = [
	'ok',
	'stale',
	'unavailable',
	'timeout',
	'not_found',
	'circuit_open',
	'disabled',
	'misconfigured',
] as const satisfies readonly ExternalSourceState[];
type MissingState = Exclude<ExternalSourceState, (typeof ALL_STATES)[number]>;
const _allStatesAreListed: MissingState extends never ? true : never = true;
void _allStatesAreListed;

/** The closed error-kind set of src/external/errors.ts. */
const ALL_ERROR_KINDS: readonly ExternalErrorKind[] = [
	'disabled',
	'not_registered',
	'bad_config',
	'circuit_open',
	'blocked_host',
	'timeout',
	'transport',
	'http_status',
	'too_large',
	'protocol',
	'not_found',
];

/**
 * The subsystem must be ENABLED and the Zenon host allowlisted, or every
 * scenario below would collapse to 'misconfigured' before the parked row is
 * ever consulted — a gate that passes because it never reached the code it
 * claims to cover. Each scenario additionally asserts its EXPECTED state.
 */
// The `misconfigured` case needs a component OWNED by an unbound section (the
// ownership rule makes any other section's record FOREIGN, not misconfigured).
beforeAll(() => ensureSituation(UNBOUND_EXTERNAL_SITUATION));
afterAll(async () => {
	expect(await dropSituation(UNBOUND_EXTERNAL_SITUATION)).toBe(0);
});

beforeEach(async () => {
	overrideExternalSettingsForTests({
		enabled: true,
		disabledServices: [],
		allowedHosts: ['zenon.dainst.org'],
		softTtlMs: 300_000,
		retryAttempts: 0,
		maxConcurrency: 4,
	});
	await clearOntologyDerivedCaches();
});

afterEach(() => {
	overrideExternalSettingsForTests(null);
});

/** Emit one item over a PARKED row view of the given status/reason. */
async function emitOver(
	status: ExternalRowView['status'],
	reason: ExternalErrorKind | undefined,
	row: unknown,
): Promise<DataItem> {
	const emission = new EmissionContext();
	setPrefetchedExternalRows(
		emission,
		new Map([
			[
				`${SECTION}|${REMOTE_ID}`,
				{
					sectionTipo: SECTION,
					remoteId: REMOTE_ID,
					service: 'zenon',
					row: row as ExternalRowView['row'],
					status,
					...(reason === undefined ? {} : { reason }),
					fetchedAt: 99,
				} satisfies ExternalRowView,
			],
		]),
	);
	await getEmitHook('component_external')?.emitItem?.({
		ddo: { tipo: COMPONENT, section_tipo: SECTION } as Ddo,
		record: { section_id: 1, columns: { relation: {} } } as unknown as MatrixRecord,
		row: { section_tipo: SECTION, section_id: REMOTE_ID as unknown as number },
		model: 'component_external',
		ddoMode: 'edit',
		ddoLang: 'lg-nolan',
		defaultMode: 'edit',
		defaultLang: 'lg-eng',
		callerTipo: SECTION,
		emission,
		door: 'read',
	});
	return emission.items[0] as DataItem;
}

// ---------------------------------------------------------------------------
// 1. Behaviour
// ---------------------------------------------------------------------------

describe('no path emits a silent blank', () => {
	/** Every reachable (status, reason) pair, plus the misconfiguration entries. */
	const scenarios: { name: string; expect: ExternalSourceState; run: () => Promise<DataItem> }[] = [
		{
			name: 'ok',
			expect: 'ok',
			run: () => emitOver('ok', undefined, { id: REMOTE_ID, authors: { p: { A: {} } } }),
		},
		{
			name: 'stale',
			expect: 'stale',
			run: () => emitOver('stale', undefined, { id: REMOTE_ID, authors: { p: { A: {} } } }),
		},
		{ name: 'not_found', expect: 'not_found', run: () => emitOver('not_found', 'not_found', null) },
		...ALL_ERROR_KINDS.map((kind) => ({
			name: `unavailable/${kind}`,
			expect: stateForKind(kind),
			run: () => emitOver('unavailable', kind, null),
		})),
		{
			name: 'unavailable/unclassified',
			expect: 'unavailable' as const,
			run: () => emitOver('unavailable', undefined, null),
		},
	];

	for (const scenario of scenarios) {
		test(`${scenario.name}: entries is a string[] — never null, never [null]`, async () => {
			const item = await scenario.run();
			expect(item.entries).not.toBeNull();
			expect(Array.isArray(item.entries)).toBe(true);
			for (const entry of item.entries as unknown[]) {
				expect(entry, `${scenario.name} emitted a non-string entry`).toBeTypeOf('string');
			}
		});

		test(`${scenario.name}: a non-'ok' item carries source_status`, async () => {
			const item = await scenario.run();
			const status = item.source_status as { state?: string } | undefined;
			if (scenario.name === 'ok') {
				expect(status, 'a clean success must carry NO provenance field').toBeUndefined();
				return;
			}
			expect(status, `${scenario.name} emitted no source_status`).toBeDefined();
			// The EXPECTED state, not merely "not ok": without this the whole
			// describe passes trivially if every scenario collapses to one state.
			expect(status?.state).toBe(scenario.expect);
		});
	}

	test('a MISCONFIGURED section emits the item too (never nothing)', async () => {
		// The component's OWN section names no service: nothing to fetch.
		const derived = await deriveExternalValue(UNBOUND_COMPONENT, UNBOUND_SECTION, REMOTE_ID);
		expect(derived.entries).toEqual([]);
		expect(derived.source_status?.state).toBe('misconfigured');
	});

	test('the derivation NEVER throws — a degraded field must not blank the record', async () => {
		// A tipo that is not a component at all, in a section that is not external:
		// the worst input the emission path can hand it.
		const derived = await deriveExternalValue('dd0', 'dd0', 'not|an|id');
		expect(derived.entries).toEqual([]);
		expect(derived.source_status).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// 2. Totality
// ---------------------------------------------------------------------------

describe('the state maps are total, and their label keys exist', () => {
	test('every declared state is in the closed set, and vice versa', () => {
		expect(Object.keys(EXTERNAL_STATE_LABEL_KEY).sort()).toEqual([...ALL_STATES].sort());
		expect(Object.keys(EXTERNAL_STATE_RETRYABLE).sort()).toEqual([...ALL_STATES].sort());
	});

	test('every error kind maps to a state in the closed set', () => {
		for (const kind of ALL_ERROR_KINDS) {
			expect(ALL_STATES, `kind '${kind}' maps outside the state set`).toContain(stateForKind(kind));
		}
	});

	test("every non-'ok' state names a label key that EXISTS in the labels master", () => {
		const master = labelsMaster as Record<string, string>;
		for (const state of ALL_STATES) {
			const key = EXTERNAL_STATE_LABEL_KEY[state];
			if (state === 'ok') {
				expect(key, "'ok' must have no label — it never reaches the wire").toBeNull();
				continue;
			}
			expect(key, `state '${state}' has no label key`).toBeTruthy();
			expect(
				Object.hasOwn(master, key as string),
				`label key '${key}' (state '${state}') is not defined in src/core/labels/master.json`,
			).toBe(true);
		}
	});

	test('the truncation label key (ok-with-drops) exists too', () => {
		const truncated = externalSourceStatus('zenon', 'ok', { droppedOverCount: 1 });
		expect(truncated).not.toBeNull();
		expect(
			Object.hasOwn(labelsMaster as Record<string, string>, truncated?.label_key as string),
		).toBe(true);
	});

	test('label_key is always a KEY, never prose', () => {
		// A key is snake_case ascii; a translated sentence is not. This is what
		// stops "External source unavailable" being written straight onto the wire.
		for (const state of ALL_STATES) {
			const key = EXTERNAL_STATE_LABEL_KEY[state];
			if (key === null) continue;
			expect(key, `label key '${key}' does not look like a catalog key`).toMatch(
				/^[a-z][a-z0-9_]*$/,
			);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. Source shape
// ---------------------------------------------------------------------------

describe('the modules carry no blank-emitting shape', () => {
	const files = ['value.ts', 'emit.ts', 'descriptor.ts'].map((name) => ({
		name,
		text: readFileSync(join(REPO_ROOT, 'src/core/components/component_external', name), 'utf8'),
	}));

	/** Drop comments before scanning — the headers DISCUSS these shapes. */
	function code(text: string): string {
		return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
	}

	test('no `entries: null` and no `[null]` anywhere in the model home', () => {
		for (const file of files) {
			const body = code(file.text);
			expect(body, `${file.name}: emits a null entries payload`).not.toMatch(/entries\s*:\s*null/);
			expect(body, `${file.name}: emits a [null] payload`).not.toMatch(/\[\s*null\s*\]/);
		}
	});

	test('no silent catch: every catch either reports a state or logs', () => {
		for (const file of files) {
			const body = code(file.text);
			expect(body, `${file.name}: has an EMPTY catch block`).not.toMatch(
				/catch\s*(\([^)]*\))?\s*\{\s*\}/,
			);
		}
	});

	test('the descriptor still declares the emit hook (not a relation resolver)', () => {
		const descriptor = getComponentModel('component_external');
		expect(descriptor?.emitHook).toBe('external');
		expect(descriptor?.resolveData).toBeUndefined();
		expect(descriptor?.importConform).toBeUndefined();
	});
});

describe('the test-only transport seam has no production caller', () => {
	test('nothing under src/ or tools/ calls setExternalTransportDepsForTests', () => {
		const callers: string[] = [];
		let scanned = 0;
		for (const root of ['src', 'tools']) {
			for (const relative of new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, root) })) {
				const path = join(root, relative);
				scanned += 1;
				const text = readFileSync(join(REPO_ROOT, path), 'utf8');
				// The DEFINITION lives in value.ts; only a CALL is a violation.
				if (path.endsWith('component_external/value.ts')) continue;
				if (text.includes('setExternalTransportDepsForTests')) callers.push(path);
			}
		}
		expect(
			callers,
			'the transport seam is TEST-ONLY — production must never inject a fetch:',
		).toEqual([]);
		expect(scanned).toBeGreaterThan(600); // anti-vacuity: the walk saw the engine
	});
});

// ---------------------------------------------------------------------------
// 4. A derived field is never WRITTEN
// ---------------------------------------------------------------------------

describe('a derived field can never be written from an import', () => {
	// The value lives in a third-party service; the local record has no slot for
	// it. Both cell shapes are therefore refused per cell, leaving whatever the
	// record holds untouched — the flat one by the no-facet tail, the json one by
	// the derived-field check (without which the model-agnostic round-trip would
	// have written a fossil into a column the read path never consults again).
	const cell = {
		componentTipo: COMPONENT,
		sectionTipo: SECTION,
		sectionId: 1,
		columnName: 'relation',
		model: 'component_external',
	};

	test('a FLAT cell is refused, and nothing is written', async () => {
		const { conformImportData } = await import('../../src/core/tools/import_data.ts');
		const result = await conformImportData({ ...cell, importValue: 'Casana, Jesse' });
		expect(result.result).toBeNull();
		expect(result.errors).toHaveLength(1);
		expect(result.msg).not.toBe('OK');
	});

	test('a JSON cell is refused too — the round-trip has nowhere to land', async () => {
		const { conformImportData } = await import('../../src/core/tools/import_data.ts');
		const result = await conformImportData({
			...cell,
			importValue: '[{"section_tipo":"test7342","section_id":"001338683"}]',
		});
		expect(result.result).toBeNull();
		expect(result.errors[0]?.msg).toContain('DERIVED');
	});

	test('an EMPTY cell is refused as well — an import must not CLEAR a derived field', async () => {
		const { conformImportData } = await import('../../src/core/tools/import_data.ts');
		const result = await conformImportData({ ...cell, importValue: '' });
		expect(result.result).toBeNull();
		expect(result.msg).not.toBe('OK');
	});
});
