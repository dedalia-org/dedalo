/**
 * component_external DEGRADATION — every way the remote can fail, and what the
 * record shows when it does.
 *
 * THE POSTURE. A heritage record must still render when a third-party service
 * is down, and the gap must be EXPLAINED: "the source did not answer" and "this
 * record has no author" look identical on screen, and a cataloguer will act on
 * the difference. v6 emitted nothing at all in every one of these cases — no
 * values, no provenance, no log the user could see. Every path here therefore
 * ends in `entries: []` PLUS a `source_status` naming the state.
 *
 * `test3` really carries a Zenon api_config and `test215` is a real
 * component_external under it, so the ontology is real; only the socket is
 * injected, and nothing is written to the database.
 */
// Migrated to the generic `test` TLD 2026-08-19: the "a real, ORDINARY (non-external)
// section" coordinate is now `test2` — test3 itself IS external in this gate (it carries
// the component_external test215).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
	deriveExternalValue,
	EXTERNAL_STATE_LABEL_KEY,
	EXTERNAL_STATE_RETRYABLE,
	type ExternalSourceState,
	externalSourceStatus,
	setExternalTransportDepsForTests,
	setPrefetchedExternalRows,
	stateForKind,
	stateForRowView,
} from '../../src/core/components/component_external/value.ts';
import { getEmitHook } from '../../src/core/components/emit_hooks.ts';
import type { Ddo } from '../../src/core/concepts/ddo.ts';
import type { MatrixRecord } from '../../src/core/db/matrix.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { type DataItem, EmissionContext } from '../../src/core/resolve/component_data.ts';
import { dropSituation, ensureSituation } from '../../src/core/test_data/situations/situation.ts';
import type { ExternalErrorKind, ExternalRowView } from '../../src/external/api/types.ts';
import { resetBreakerForOrigin } from '../../src/external/breaker.ts';
import { drainInFlightExternalFetches, externalRowViewKey } from '../../src/external/cache.ts';
import { overrideExternalSettingsForTests } from '../../src/external/settings.ts';
import type { ExternalFetchImpl } from '../../src/external/transport.ts';
import {
	UNBOUND_COMPONENT,
	UNBOUND_EXTERNAL_SITUATION,
	UNBOUND_SECTION,
} from '../helpers/external_unbound_situation.ts';

const HOST = 'zenon.dainst.org';
const ORIGIN = `https://${HOST}`;
const SECTION = 'test3';
const COMPONENT = 'test215';
const REMOTE_ID = '000848571';

const AUTHORS_ROW = {
	id: REMOTE_ID,
	authors: { primary: { 'Casana, Jesse': {} } },
};

/** The 11 kinds of src/external/errors.ts — the closed set, restated here so a
 * NEW kind fails this file rather than silently collapsing to 'unavailable'. */
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

function deps(impl: ExternalFetchImpl) {
	return {
		fetchImpl: impl,
		assertPublicUrlImpl: async (uri: string) => ({ url: new URL(uri), addresses: ['141.100.1.1'] }),
	};
}

function emissionWith(configure: (emission: EmissionContext) => void): EmissionContext {
	const emission = new EmissionContext();
	configure(emission);
	return emission;
}

function parked(
	status: ExternalRowView['status'],
	reason?: ExternalErrorKind,
	row: unknown = null,
	fetchedAt = 1_234,
): (emission: EmissionContext) => void {
	return (emission) => {
		setPrefetchedExternalRows(
			emission,
			new Map([
				[
					externalRowViewKey(SECTION, REMOTE_ID),
					{
						sectionTipo: SECTION,
						remoteId: REMOTE_ID,
						service: 'zenon',
						row: row as ExternalRowView['row'],
						status,
						...(reason === undefined ? {} : { reason }),
						fetchedAt,
					} satisfies ExternalRowView,
				],
			]),
		);
	};
}

/** Emit through the real hook in a given MODE (the list/tm vs edit contract). */
async function emitInMode(
	mode: string,
	configure: (e: EmissionContext) => void,
): Promise<DataItem> {
	const emission = emissionWith(configure);
	await getEmitHook('component_external')?.emitItem?.({
		ddo: { tipo: COMPONENT, section_tipo: SECTION } as Ddo,
		record: { section_id: 1, columns: { relation: {} } } as unknown as MatrixRecord,
		row: { section_tipo: SECTION, section_id: REMOTE_ID as unknown as number },
		model: 'component_external',
		ddoMode: mode,
		ddoLang: 'lg-nolan',
		defaultMode: mode,
		defaultLang: 'lg-eng',
		callerTipo: SECTION,
		emission,
	});
	return emission.items[0] as DataItem;
}

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
		allowedHosts: [HOST],
		softTtlMs: 300_000,
		retryAttempts: 0,
		maxConcurrency: 4,
	});
	resetBreakerForOrigin('zenon', ORIGIN);
	await clearOntologyDerivedCaches();
});

afterEach(async () => {
	overrideExternalSettingsForTests(null);
	await drainInFlightExternalFetches();
	resetBreakerForOrigin('zenon', ORIGIN);
});

describe('the failure taxonomy maps onto the wire states', () => {
	test('every error kind has a state, and the map is TOTAL', () => {
		for (const kind of ALL_ERROR_KINDS) {
			const state = stateForKind(kind);
			expect(EXTERNAL_STATE_LABEL_KEY[state], `kind '${kind}' → state '${state}'`).toBeTruthy();
		}
	});

	test('the kinds a user or operator can ACT on keep their own state', () => {
		expect(stateForKind('timeout')).toBe('timeout');
		expect(stateForKind('circuit_open')).toBe('circuit_open');
		expect(stateForKind('disabled')).toBe('disabled');
		expect(stateForKind('not_found')).toBe('not_found');
		// The three CONFIGURATION failures collapse to one operator-facing state.
		expect(stateForKind('bad_config')).toBe('misconfigured');
		expect(stateForKind('blocked_host')).toBe('misconfigured');
		expect(stateForKind('not_registered')).toBe('misconfigured');
		// The rest are "the remote did not work", which is one thing to a user.
		for (const kind of ['transport', 'http_status', 'too_large', 'protocol'] as const) {
			expect(stateForKind(kind)).toBe('unavailable');
		}
	});

	test('retryable is FALSE exactly where waiting cannot help', () => {
		const notRetryable = (Object.keys(EXTERNAL_STATE_RETRYABLE) as ExternalSourceState[])
			.filter((state) => !EXTERNAL_STATE_RETRYABLE[state])
			.sort();
		expect(notRetryable).toEqual(['disabled', 'misconfigured', 'not_found', 'ok']);
	});

	test('a row view carries its reason into the state', () => {
		expect(stateForRowView({ status: 'ok' } as ExternalRowView)).toBe('ok');
		expect(stateForRowView({ status: 'stale' } as ExternalRowView)).toBe('stale');
		expect(stateForRowView({ status: 'not_found' } as ExternalRowView)).toBe('not_found');
		expect(stateForRowView({ status: 'unavailable', reason: 'timeout' } as ExternalRowView)).toBe(
			'timeout',
		);
		// An unavailable row with no classified reason is still reported.
		expect(stateForRowView({ status: 'unavailable' } as ExternalRowView)).toBe('unavailable');
	});
});

describe('each state, end to end through the derivation', () => {
	test("'stale' serves the last good row AND says so, with stale_since", async () => {
		const derived = await deriveExternalValue(COMPONENT, SECTION, REMOTE_ID, {
			emission: emissionWith(parked('stale', undefined, AUTHORS_ROW, 4_242)),
		});
		expect(derived.entries).toEqual(['primary: Casana, Jesse']);
		expect(derived.source_status).toMatchObject({
			service: 'zenon',
			state: 'stale',
			label_key: 'external_source_stale',
			retryable: true,
			stale_since: 4_242,
		});
	});

	test("'not_found' — the service answered and the record is not in it", async () => {
		const derived = await deriveExternalValue(COMPONENT, SECTION, REMOTE_ID, {
			emission: emissionWith(parked('not_found', 'not_found')),
		});
		expect(derived.entries).toEqual([]);
		expect(derived.source_status).toMatchObject({ state: 'not_found', retryable: false });
	});

	test("'timeout' — the request ran out of time", async () => {
		const derived = await deriveExternalValue(COMPONENT, SECTION, REMOTE_ID, {
			emission: emissionWith(parked('unavailable', 'timeout')),
		});
		expect(derived.source_status).toMatchObject({ state: 'timeout', retryable: true });
	});

	test("'circuit_open' — the breaker is holding the host off", async () => {
		const derived = await deriveExternalValue(COMPONENT, SECTION, REMOTE_ID, {
			emission: emissionWith(parked('unavailable', 'circuit_open')),
		});
		expect(derived.source_status).toMatchObject({ state: 'circuit_open', retryable: true });
	});

	test("'unavailable' — an http failure with nothing cached (a REAL transport run)", async () => {
		const derived = await deriveExternalValue(COMPONENT, SECTION, REMOTE_ID, {
			emission: emissionWith((emission) => {
				setExternalTransportDepsForTests(
					emission,
					deps(async () => new Response('nope', { status: 503 })),
				);
			}),
		});
		expect(derived.entries).toEqual([]);
		expect(derived.source_status).toMatchObject({ state: 'unavailable', retryable: true });
	});

	test("'disabled' — the operator's master switch (a REAL transport run)", async () => {
		overrideExternalSettingsForTests({
			enabled: false,
			disabledServices: [],
			allowedHosts: [HOST],
			softTtlMs: 300_000,
			retryAttempts: 0,
			maxConcurrency: 4,
		});
		await clearOntologyDerivedCaches();
		const derived = await deriveExternalValue(COMPONENT, SECTION, REMOTE_ID, {
			emission: emissionWith((emission) => {
				setExternalTransportDepsForTests(
					emission,
					deps(async () => {
						throw new Error('the socket must never be reached when disabled');
					}),
				);
			}),
		});
		expect(derived.entries).toEqual([]);
		expect(derived.source_status).toMatchObject({
			state: 'disabled',
			label_key: 'external_source_disabled',
			retryable: false,
		});
	});

	test("'misconfigured' — a section that names no service at all", async () => {
		// The component's OWN section carries no api_config: nothing can be fetched.
		const derived = await deriveExternalValue(UNBOUND_COMPONENT, UNBOUND_SECTION, REMOTE_ID);
		expect(derived.entries).toEqual([]);
		expect(derived.source_status).toMatchObject({ state: 'misconfigured', retryable: false });
	});

	test('a FOREIGN section is not a state at all — the column does not apply', async () => {
		// test2 is a real, ordinary section that does not own test215 (§3 addendum
		// 2026-09-24): no status, because nothing failed and nothing was asked.
		expect(await deriveExternalValue(COMPONENT, 'test2', REMOTE_ID)).toEqual({ entries: [] });
	});

	test("'misconfigured' — a component with no fields_map has no mapping to apply", async () => {
		// test52 is a real tipo (component_input_text) that declares no fields_map.
		const derived = await deriveExternalValue('test52', SECTION, REMOTE_ID, {
			emission: emissionWith(parked('ok', undefined, AUTHORS_ROW)),
		});
		expect(derived.entries).toEqual([]);
		expect(derived.source_status).toMatchObject({ state: 'misconfigured' });
	});

	test('an EMPTY remote id addresses no record — reported, not fetched', async () => {
		const derived = await deriveExternalValue(COMPONENT, SECTION, '');
		expect(derived.source_status).toMatchObject({ state: 'misconfigured' });
	});
});

describe('the emission ceilings are reported, never silent', () => {
	test('an over-long value is REFUSED and counted, with a truncation label', async () => {
		overrideExternalSettingsForTests({
			enabled: true,
			disabledServices: [],
			allowedHosts: [HOST],
			softTtlMs: 300_000,
			retryAttempts: 0,
			maxConcurrency: 4,
			maxEntryChars: 5,
		});
		await clearOntologyDerivedCaches();
		const derived = await deriveExternalValue(COMPONENT, SECTION, REMOTE_ID, {
			emission: emissionWith(parked('ok', undefined, AUTHORS_ROW)),
		});
		expect(derived.entries).toEqual([]);
		// The row itself was FINE — the loss is the ceiling's, and it is named.
		expect(derived.source_status).toMatchObject({
			state: 'ok',
			label_key: 'external_source_truncated',
			dropped_over_length: 1,
		});
	});
});

describe('the empty shape is the SAME in every mode (the v6 split is gone)', () => {
	// v6 emitted `value: [null]` in edit and `value: null` in list/tm. v7 emits
	// the WC-001 `entries: []` form in BOTH, plus the provenance.
	for (const mode of ['edit', 'list', 'tm']) {
		test(`mode '${mode}': entries [] (never [null], never null) + source_status`, async () => {
			const item = await emitInMode(mode, parked('unavailable', 'transport'));
			expect(item.entries).toEqual([]);
			expect(item.mode).toBe(mode);
			expect(item.source_status).toBeDefined();
		});
	}

	test('a successful value is identical in edit and in list', async () => {
		const edit = await emitInMode('edit', parked('ok', undefined, AUTHORS_ROW));
		const list = await emitInMode('list', parked('ok', undefined, AUTHORS_ROW));
		expect(list.entries).toEqual(edit.entries);
		expect(Object.hasOwn(edit, 'source_status')).toBe(false);
		expect(Object.hasOwn(list, 'source_status')).toBe(false);
	});
});

describe('the KEPT search-mode guards (generic, not artifacts of the old misroute)', () => {
	// read.ts:750 and read_facade.ts:178 name component_external as an EXAMPLE of
	// a model whose client search render reads `data.entries[0]` unguarded
	// (render_search_component_external.js:178). They guarantee a main item with
	// entries:[] for ANY model in search mode, and they run BEFORE any per-model
	// dispatch — so the emit-hook rewrite neither needs nor changes them. These
	// pin that the guarantee still holds, and that the source files still say so.
	const readSource = Bun.file(new URL('../../src/core/section/read.ts', import.meta.url));
	const facadeSource = Bun.file(new URL('../../src/core/section/read_facade.ts', import.meta.url));

	test('the search-mode blank-item guarantee is still stated where it is enforced', async () => {
		const text = await readSource.text();
		expect(text).toContain('render_search_component_external');
		// The guarantee itself: a search-mode source with a null record answers an
		// item with entries:[] rather than nothing. Since 2026-11-03 the
		// producers answer {items, nodes} (the element-node registry rides with
		// the items), so the item array may be wrapped by `bareData(…)`.
		expect(text).toMatch(
			/if \(\(source\.mode \?\? 'edit'\) === 'search'\) \{\s*\n\s*return (?:bareData\()?\[buildDataItem\(/,
		);
	});

	test("resolve_data still guarantees the component's OWN item", async () => {
		const text = await facadeSource.text();
		expect(text).toContain('render_search_component_external');
		expect(text).toContain('resolved.unshift(');
	});

	test('a search-mode emission is NOT what the hook answers (the guards run first)', async () => {
		// Sanity: the hook is mode-agnostic by design — it never special-cases
		// 'search', because it is never reached in that mode.
		const item = await emitInMode('search', parked('ok', undefined, AUTHORS_ROW));
		expect(item.mode).toBe('search');
		expect(item.entries).toEqual(['primary: Casana, Jesse']);
	});
});

describe('externalSourceStatus (the wire-field builder)', () => {
	test("a clean 'ok' produces NO field at all", () => {
		expect(externalSourceStatus('zenon', 'ok')).toBeNull();
	});

	test('every non-ok state produces a field with a label key and a retryable flag', () => {
		for (const state of Object.keys(EXTERNAL_STATE_LABEL_KEY) as ExternalSourceState[]) {
			if (state === 'ok') continue;
			const status = externalSourceStatus('zenon', state);
			expect(status, `state '${state}' produced no field`).not.toBeNull();
			expect(status?.label_key).toBe(EXTERNAL_STATE_LABEL_KEY[state] as string);
			expect(status?.retryable).toBe(EXTERNAL_STATE_RETRYABLE[state]);
			expect(status?.service).toBe('zenon');
		}
	});

	test('stale_since rides only on stale', () => {
		expect(externalSourceStatus('zenon', 'stale', { staleSince: 7 })?.stale_since).toBe(7);
		expect(
			Object.hasOwn(
				externalSourceStatus('zenon', 'timeout', { staleSince: 7 }) ?? {},
				'stale_since',
			),
		).toBe(false);
	});
});
