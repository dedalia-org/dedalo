/**
 * component_external EMISSION — the item shape, the prefetch path, and the
 * FALLBACK that exists so no read ever emits a silent blank.
 *
 * THE BUG THIS GATE REPLACES. Until 2026-08-05 the descriptor named
 * `resolveData: 'portal'`, which routed the model into expandPortal —
 * `record.columns.relation['zenon4']` is empty for every external record (there
 * is no matrix row anywhere for an external section, and no `matrix_zenon`
 * table), so the resolver returned early and the model emitted ZERO items,
 * always. The first test here is the direct regression pin: an emission over a
 * record with an EMPTY relation column still produces the component's item.
 *
 * `test3` is the canonical playground section and really carries a Zenon
 * `api_config`; `test215` is a real `component_external` under it, with
 * `fields_map: [{local:'dato', remote:'authors', format:'zenon_authors'}]`.
 * These therefore run against the REAL ontology resolver — only the socket is
 * injected, and nothing is written to the database.
 */
// Migrated to the generic `test` TLD 2026-08-19: the "a REAL, ordinary (non-external)
// section" coordinate is now `test2` — test3 itself IS external here (it carries the
// component_external test215).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
	setExternalTransportDepsForTests,
	setPrefetchedExternalRows,
} from '../../src/core/components/component_external/value.ts';
import { getEmitHook } from '../../src/core/components/emit_hooks.ts';
import type { Ddo } from '../../src/core/concepts/ddo.ts';
import type { MatrixRecord } from '../../src/core/db/matrix.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { type DataItem, EmissionContext } from '../../src/core/resolve/component_data.ts';
import { dropSituation, ensureSituation } from '../../src/core/test_data/situations/situation.ts';
import type { ExternalRowView } from '../../src/external/api/types.ts';
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
/** A zero-padded remote id — the whole point of never Number()-ing it. */
const REMOTE_ID = '000848571';

const AUTHORS_ROW = {
	id: REMOTE_ID,
	// The Zenon `authors` shape: role → {name: …} (see services/zenon.ts).
	authors: { primary: { 'Casana, Jesse': {} }, secondary: { 'Cothren, Jackson': {} } },
};

/** A record whose relation column is EMPTY — the shape that broke the old route. */
function emptyRecord(): MatrixRecord {
	return {
		section_id: 1,
		columns: { relation: {}, string: {} },
	} as unknown as MatrixRecord;
}

function fetchReturning(payload: unknown, status = 200): ExternalFetchImpl {
	return async () => new Response(JSON.stringify(payload), { status });
}

function deps(impl: ExternalFetchImpl) {
	return {
		fetchImpl: impl,
		assertPublicUrlImpl: async (uri: string) => ({ url: new URL(uri), addresses: ['141.100.1.1'] }),
	};
}

/** Run the hook over one (section, id) and return the ONE item it pushed. */
async function emitOne(
	sectionId: string | number,
	configure: (emission: EmissionContext) => void = () => {},
): Promise<DataItem> {
	const emission = new EmissionContext();
	configure(emission);
	const hook = getEmitHook('component_external');
	expect(hook?.emitItem, 'component_external must declare a REPLACE emit hook').toBeDefined();
	await hook?.emitItem?.({
		ddo: { tipo: COMPONENT, section_tipo: SECTION } as Ddo,
		record: emptyRecord(),
		row: { section_tipo: SECTION, section_id: sectionId as number },
		model: 'component_external',
		ddoMode: 'edit',
		ddoLang: 'lg-nolan',
		defaultMode: 'edit',
		defaultLang: 'lg-eng',
		callerTipo: SECTION,
		emission,
		door: 'read',
	});
	expect(emission.items).toHaveLength(1);
	return emission.items[0] as DataItem;
}

/** A prefetched row view, as the batching wiring stage will park it. */
function parkRow(status: ExternalRowView['status'], row: unknown, fetchedAt = 1_000) {
	return (emission: EmissionContext): void => {
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
						fetchedAt,
					} satisfies ExternalRowView,
				],
			]),
		);
	};
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

describe('the emitted item (the shape the client renders)', () => {
	test('an EMPTY relation column still emits the item — the portal-misroute pin', async () => {
		const item = await emitOne(REMOTE_ID, parkRow('ok', AUTHORS_ROW));
		expect(item.tipo).toBe(COMPONENT);
		expect((item.entries ?? []).length).toBeGreaterThan(0);
	});

	test('it is LITERAL-shaped: string entries, lg-nolan, own from_component_tipo', async () => {
		const item = await emitOne(REMOTE_ID, parkRow('ok', AUTHORS_ROW));
		expect(Array.isArray(item.entries)).toBe(true);
		for (const entry of item.entries ?? []) expect(typeof entry).toBe('string');
		expect(item.lang).toBe('lg-nolan');
		expect(item.from_component_tipo).toBe(COMPONENT);
		expect(item.section_tipo).toBe(SECTION);
		expect(item.mode).toBe('edit');
		expect(item.parent_tipo).toBe(SECTION);
	});

	test("the value is the adapter's, not a raw payload echo", async () => {
		const item = await emitOne(REMOTE_ID, parkRow('ok', AUTHORS_ROW));
		// zenon_authors: '<role>: ' + names joined ' - ', roles joined ' | '
		// (class.component_external.php:213-232, reproduced exactly).
		expect(item.entries).toEqual(['primary: Casana, Jesse | secondary: Cothren, Jackson']);
	});

	test('a fresh, complete success carries NO source_status (byte-identical happy path)', async () => {
		const item = await emitOne(REMOTE_ID, parkRow('ok', AUTHORS_ROW));
		expect(Object.hasOwn(item, 'source_status')).toBe(false);
	});

	test('and NO entries_kind — the client renders text unless told otherwise', async () => {
		// WC-2026-08-06-external-client-render: `entries_kind` is the ONLY thing
		// that can make the client parse a third-party string as HTML, so it must
		// be absent from every emission the installation can currently produce (no
		// registered adapter formats markup). Its presence rule is covered in
		// external_fields_map_native; this is the pin that the LIVE path is text.
		for (const status of ['ok', 'stale'] as const) {
			const item = await emitOne(REMOTE_ID, parkRow(status, AUTHORS_ROW));
			expect(Object.hasOwn(item, 'entries_kind')).toBe(false);
		}
	});

	test('the zero-padded section_id is echoed VERBATIM — never Number()d', async () => {
		const item = await emitOne(REMOTE_ID, parkRow('ok', AUTHORS_ROW));
		// The client matches its instance by String(el.section_id) === String(self.section_id);
		// Number('000848571') is 848571, which matches nothing and asks the
		// service for a different record.
		expect(item.section_id).toBe(REMOTE_ID);
		expect(typeof item.section_id).toBe('string');
	});

	test('a numeric row id stays numeric (unchanged for ordinary sections)', async () => {
		// No prefetched row for THIS id, so the fallback runs — the socket is
		// injected so the suite never leaves the machine. The ECHO is under test.
		const item = await emitOne(848_571, (emission) => {
			setExternalTransportDepsForTests(
				emission,
				deps(fetchReturning({ records: [{ ...AUTHORS_ROW, id: '848571' }], status: 'OK' })),
			);
		});
		expect(item.section_id).toBe(848_571);
		expect(typeof item.section_id).toBe('number');
	});
});

describe('the FALLBACK — an emission with no prefetched row resolves its own', () => {
	test('it fetches through the facade and emits real values', async () => {
		const item = await emitOne(REMOTE_ID, (emission) => {
			setExternalTransportDepsForTests(
				emission,
				deps(fetchReturning({ records: [AUTHORS_ROW], status: 'OK' })),
			);
		});
		expect(item.entries).toEqual(['primary: Casana, Jesse | secondary: Cothren, Jackson']);
		expect(Object.hasOwn(item, 'source_status')).toBe(false);
	});

	test('a prefetched row WINS — the fallback issues no request', async () => {
		let calls = 0;
		const item = await emitOne(REMOTE_ID, (emission) => {
			parkRow('ok', AUTHORS_ROW)(emission);
			setExternalTransportDepsForTests(
				emission,
				deps(async () => {
					calls++;
					return new Response('{}', { status: 200 });
				}),
			);
		});
		expect(calls).toBe(0);
		expect(item.entries).toEqual(['primary: Casana, Jesse | secondary: Cothren, Jackson']);
	});

	test('a remote answer that is NOT the requested record degrades, never guesses', async () => {
		const item = await emitOne(REMOTE_ID, (emission) => {
			setExternalTransportDepsForTests(
				emission,
				deps(fetchReturning({ records: [{ ...AUTHORS_ROW, id: '000000001' }], status: 'OK' })),
			);
		});
		expect(item.entries).toEqual([]);
		expect((item.source_status as { state: string }).state).toBe('not_found');
	});
});

describe("'misconfigured' rather than a bare []", () => {
	test('a section with NO api_config is misconfigured, not empty', async () => {
		const emission = new EmissionContext();
		const hook = getEmitHook('component_external');
		await hook?.emitItem?.({
			ddo: { tipo: UNBOUND_COMPONENT, section_tipo: UNBOUND_SECTION } as Ddo,
			record: emptyRecord(),
			// The component's OWN section, which names no service.
			row: { section_tipo: UNBOUND_SECTION, section_id: 1 },
			model: 'component_external',
			ddoMode: 'edit',
			ddoLang: 'lg-nolan',
			defaultMode: 'edit',
			defaultLang: 'lg-eng',
			callerTipo: UNBOUND_SECTION,
			emission,
			door: 'read',
		});
		const item = emission.items[0] as DataItem;
		expect(item.entries).toEqual([]);
		expect(item.source_status).toMatchObject({
			state: 'misconfigured',
			label_key: 'external_source_misconfigured',
			retryable: false,
		});
	});

	test('an allowlist that excludes the host is misconfigured (fail-closed egress)', async () => {
		overrideExternalSettingsForTests({
			enabled: true,
			disabledServices: [],
			allowedHosts: [], // the shipped default: nothing may leave
			softTtlMs: 300_000,
			retryAttempts: 0,
			maxConcurrency: 4,
		});
		await clearOntologyDerivedCaches();
		const item = await emitOne(REMOTE_ID);
		expect(item.entries).toEqual([]);
		// Classified via the DOOR (blocked_host), so the real service is named —
		// before 2026-09-27 parse refused and it read 'unknown'.
		expect(item.source_status).toMatchObject({ state: 'misconfigured', service: 'zenon' });
	});
});

describe("the FLAT cell (relation_list / export atoms, flatValue family 'external')", () => {
	// A section_list column of an external section is a live surface: zenon8
	// really lists zenon3..zenon6. The cell CANNOT go through the normal route —
	// resolveCellValue loads a matrix record first, and an external section has
	// no table and no rows — so the family gets its own branch ahead of that.
	test('it derives the value instead of resolving to a silent null', async () => {
		const { resolveCellValue } = await import('../../src/core/resolve/relation_list.ts');
		const unresolved: string[] = [];
		// No prefetch and no per-read emission here (an export has neither), so
		// this exercises the derivation's own fetch — with the real socket, which
		// the empty allowlist keeps closed. What is under test is that the branch
		// RUNS at all: a null from the table lookup would be indistinguishable.
		overrideExternalSettingsForTests({
			enabled: true,
			disabledServices: [],
			allowedHosts: [], // fail-closed: nothing leaves the machine
			softTtlMs: 300_000,
			retryAttempts: 0,
			maxConcurrency: 4,
		});
		await clearOntologyDerivedCaches();
		const cell = await resolveCellValue(SECTION, 848_571, COMPONENT, 'lg-eng', unresolved);
		expect(cell).toBeNull();
		// The degraded cell is REPORTED, not silently blank.
		expect(unresolved).toContain('component_external');
	});

	test('the family is declared on the descriptor (not the literal string family)', async () => {
		const { getComponentModel } = await import('../../src/core/components/registry.ts');
		// 'string' would lang-slice a stored jsonb value this model does not have,
		// resolving every cell to null while claiming a value exists.
		expect(getComponentModel('component_external')?.flatValue).toBe('external');
	});
});
