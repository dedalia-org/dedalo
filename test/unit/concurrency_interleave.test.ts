/**
 * Standing concurrency-interleave test — the persistent-runtime discipline
 * invariant (spec §4 request isolation): concurrent requests with DIFFERENT
 * users/principals AND DIFFERENT languages must never observe each other's
 * request-scoped state. Any module-level state leak (a cached principal, a
 * shared mutable "current user"/lang) makes this fail nondeterministically —
 * run it on every merge.
 *
 * Three layers:
 *  1. MECHANISM (deterministic, no DB): the request-context + language ALS
 *     scopes that dispatchRqo opens keep the principal and langs isolated across
 *     concurrent, interleaved async trees. This is the direct proof of the §4
 *     invariant for the seeded principal.
 *  2. DISPATCH INTEGRATION (deterministic, Postgres-free): two concurrent
 *     authenticated requests through the REAL dispatchRqo path (gates → seed →
 *     scope open → handler) mutate only their own session — no cross-request
 *     bleed at the actual chokepoint.
 *  3. RESOLVER lang read (DB-backed): interleaved lg-spa/lg-eng section reads
 *     each carry their own request's language and values.
 *  4. GRID-COLUMNS cache (DB-backed, S1-12): the descriptor-grid column cache
 *     is keyed by the application lang and hub-cleared — a Spanish-first
 *     process must serve English labels to a later lg-eng request.
 *  5. TOOLS REGISTRY cache (DB-backed, S1-13): getElementTools resolves labels
 *     per call from lang-independent cached rows — an lg-eng request after an
 *     lg-spa build must receive English labels, never cache-owned objects.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rule). Install tipos
// were replaced by their twins from src/core/test_data/test_tld_tipo_map.json; the
// seed-shipped ones (rsc/dd/hierarchy/ontology/lg) have no twin and stay, because they
// ship with every installation.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ApiRequestContext, dispatchRqo } from '../../src/core/api/dispatch.ts';
import { resolveGridColumns } from '../../src/core/components/component_info/widgets/grid.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import {
	currentApplicationLang,
	currentDataLang,
	runWithRequestLangs,
} from '../../src/core/resolve/request_lang.ts';
import {
	buildStructureContext,
	clearStructureContextCache,
} from '../../src/core/resolve/structure_context.ts';
import { readSectionRows } from '../../src/core/section/read.ts';
import type { Principal } from '../../src/core/security/permissions.ts';

/** Repo root, for the ISO-02 key-shape pin at the end of this file. */
const REPO_ROOT_ISO = join(import.meta.dir, '..', '..');

import {
	currentPrincipal,
	runWithRequestContext,
} from '../../src/core/security/request_context.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { getElementTools, resetRegistryCache } from '../../src/core/tools/registry.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

// Generic-TLD migration 2026-08-20 (AGENTS.md hard rule). The `rsc`/`oh` tipos this
// gate names are SEED-SHIPPED ontology — they exist on every installation, so they are
// generic already and stay. They are spelled through `seed()` so the census can tell an
// install BINDING from a seed reference, and so the intent is explicit at each site.

registerSessionCleanup();

// --- Layer 1: mechanism (the seeded principal + langs never bleed) ----------

const ADMIN: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
const USER: Principal = { userId: 42, isGlobalAdmin: false, isDeveloper: false };

/**
 * Run inside the same nested scopes dispatchRqo opens, then repeatedly yield to
 * the event loop and assert the accessors STILL return this branch's values —
 * so a concurrent branch with a different principal/lang cannot corrupt them.
 */
async function isolatedProbe(
	principal: Principal,
	langs: { applicationLang: string; dataLang: string },
	rounds: number,
): Promise<number | undefined> {
	return runWithRequestContext(
		{ principal, session: null, requestId: `r-${principal.userId}`, clientIp: 'x' },
		() =>
			runWithRequestLangs(langs, async () => {
				for (let round = 0; round < rounds; round++) {
					await Promise.resolve();
					await new Promise((resolve) => setTimeout(resolve, 0)); // yield: force interleave
					expect(currentPrincipal()?.userId).toBe(principal.userId);
					expect(currentPrincipal()?.isGlobalAdmin).toBe(principal.isGlobalAdmin);
					expect(currentApplicationLang()).toBe(langs.applicationLang);
					expect(currentDataLang()).toBe(langs.dataLang);
				}
				return currentPrincipal()?.userId;
			}),
	);
}

describe('request isolation — mechanism (principal + langs)', () => {
	test('concurrent interleaved requests with different principals + langs never bleed', async () => {
		const [adminResult, userResult] = await Promise.all([
			isolatedProbe(ADMIN, { applicationLang: 'lg-spa', dataLang: 'lg-spa' }, 40),
			isolatedProbe(USER, { applicationLang: 'lg-eng', dataLang: 'lg-cat' }, 40),
		]);
		expect(adminResult).toBe(-1);
		expect(userResult).toBe(42);
	}, 30000);

	test('accessors fall back to install defaults outside any request scope', () => {
		expect(currentPrincipal()).toBeUndefined();
		expect(typeof currentApplicationLang()).toBe('string');
	});
});

// --- Layer 2: dispatch integration (the real chokepoint isolates per session) --

function changeLangRqo(applicationLang: string): Rqo {
	return {
		action: 'change_lang',
		dd_api: 'dd_utils_api',
		options: { dedalo_application_lang: applicationLang },
	} as unknown as Rqo;
}

function contextForToken(token: string): ApiRequestContext {
	const session = getSession(token);
	return {
		requestId: token.slice(0, 6),
		clientIp: 'local',
		session,
		sessionToken: token,
		csrfCandidate: session?.csrfToken ?? null,
	};
}

describe('request isolation — dispatch integration', () => {
	test('two concurrent change_lang requests through dispatchRqo mutate only their own session', async () => {
		// Two distinct authenticated sessions (root resolves the principal in
		// memory — Postgres-free). Each drives change_lang to a DIFFERENT interface
		// language through the full gate → seed → scope path, concurrently.
		const tokenA = createSession(-1, 'rootA', true);
		const tokenB = createSession(-1, 'rootB', true);
		await Promise.all([
			dispatchRqo(changeLangRqo('lg-eng'), contextForToken(tokenA)),
			dispatchRqo(changeLangRqo('lg-cat'), contextForToken(tokenB)),
		]);
		// No cross-request bleed: each session persisted only its own choice.
		expect(getSession(tokenA)?.applicationLang).toBe('lg-eng');
		expect(getSession(tokenB)?.applicationLang).toBe('lg-cat');
	});
});

// --- Layer 3: resolver-level lang read (DB-backed) --------------------------

function buildReadRqo(lang: string): Rqo {
	return {
		action: 'read',
		source: {
			model: 'section',
			tipo: 'testmint1',
			section_tipo: 'testmint1',
			mode: 'list',
			lang,
			action: 'search',
		},
		sqo: { section_tipo: ['testmint1'], limit: 3, offset: 0 },
		show: {
			ddo_map: [{ tipo: 'testmint1002', section_tipo: 'self', parent: 'self', mode: 'list', lang }],
		},
	} as unknown as Rqo;
}

describe('request isolation — resolver lang read', () => {
	test('10 interleaved rounds of lg-spa vs lg-eng reads never cross-contaminate', async () => {
		const rounds = Array.from({ length: 10 }, async () => {
			const [spanishData, englishData] = await Promise.all([
				readSectionRows(buildReadRqo('lg-spa')),
				readSectionRows(buildReadRqo('lg-eng')),
			]);
			for (const item of spanishData.slice(1) as Record<string, unknown>[]) {
				expect(item.lang).toBe('lg-spa');
				for (const entry of (item.entries as { lang: string }[] | null) ?? []) {
					expect(entry.lang).toBe('lg-spa');
				}
			}
			for (const item of englishData.slice(1) as Record<string, unknown>[]) {
				expect(item.lang).toBe('lg-eng');
				for (const entry of (item.entries as { lang: string }[] | null) ?? []) {
					expect(entry.lang).toBe('lg-eng');
				}
			}
		});
		await Promise.all(rounds);
	}, 30000);
});

// --- Layer 4: grid-columns cache — application-lang keyed + hub-cleared (S1-12) --

/**
 * rsc860 is the descriptors-grid component the test6883 widget targets: its
 * request_config carries show.get_ddo_map {model:'section_map'}, so its
 * dynamic columns resolve section_map term labels in the APPLICATION lang.
 * Ontology-only — no oral-history record data is needed to resolve columns.
 */
const GRID_COMPONENT = seed('rsc', 860);
const GRID_OWNER_SECTION = 'test6813';

function gridLabels(lang: string): Promise<string[]> {
	return runWithRequestLangs({ applicationLang: lang, dataLang: lang }, async () =>
		(await resolveGridColumns(GRID_COMPONENT, GRID_OWNER_SECTION)).map((column) => column.label),
	);
}

describe('request isolation — grid-columns cache (S1-12)', () => {
	test('lg-eng after an lg-spa build receives English labels (no first-lang poisoning)', async () => {
		// Spanish FIRST so its build populates the cache before English asks.
		const spanish = await gridLabels('lg-spa');
		const english = await gridLabels('lg-eng');
		expect(spanish).toContain('Término');
		expect(english).toContain('Term');
		expect(english).not.toContain('Término');

		// Interleaved rounds: concurrent requests stay isolated too.
		await Promise.all([
			(async () => expect(await gridLabels('lg-spa')).toEqual(spanish))(),
			(async () => expect(await gridLabels('lg-eng')).toEqual(english))(),
		]);
	}, 30000);

	test('the cache is registered with the ontology invalidation hub', async () => {
		const before = await runWithRequestLangs(
			{ applicationLang: 'lg-spa', dataLang: 'lg-spa' },
			() => resolveGridColumns(GRID_COMPONENT, GRID_OWNER_SECTION),
		);
		const cachedAgain = await runWithRequestLangs(
			{ applicationLang: 'lg-spa', dataLang: 'lg-spa' },
			() => resolveGridColumns(GRID_COMPONENT, GRID_OWNER_SECTION),
		);
		expect(cachedAgain).toBe(before); // cache hit: same array identity

		await clearOntologyDerivedCaches();
		const after = await runWithRequestLangs({ applicationLang: 'lg-spa', dataLang: 'lg-spa' }, () =>
			resolveGridColumns(GRID_COMPONENT, GRID_OWNER_SECTION),
		);
		expect(after).not.toBe(before); // hub fire dropped the entry → rebuilt
		expect(after).toEqual(before);
	}, 30000);
});

// --- Layer 5: tools registry — labels resolve per call, per request (S1-13) --

describe('request isolation — tools registry cache (S1-13)', () => {
	// A translatable text component: matches tool_time_machine via all_components
	// through the PRODUCTION entry (structure_context stamps entry.tools with this).
	const target = {
		model: 'component_input_text',
		tipo: 'test6836',
		isComponent: true,
		translatable: true,
		toolConfigKeys: [],
	};

	function toolLabel(tools: { name: string; label: string }[], name: string): string | undefined {
		return tools.find((tool) => tool.name === name)?.label;
	}

	test('lg-eng after an lg-spa cache build receives English labels', async () => {
		resetRegistryCache(); // the lg-spa request below performs the build
		const spanish = await runWithRequestLangs(
			{ applicationLang: 'lg-spa', dataLang: 'lg-spa' },
			() => getElementTools(target),
		);
		expect(toolLabel(spanish.tools, 'tool_time_machine')).toBe('Máquina del tiempo');

		const english = await runWithRequestLangs(
			{ applicationLang: 'lg-eng', dataLang: 'lg-eng' },
			() => getElementTools(target),
		);
		expect(toolLabel(english.tools, 'tool_time_machine')).toBe('Time machine');
	}, 30000);

	test('callers receive fresh objects, never the cache-owned entries', async () => {
		const [first, second] = await Promise.all([
			runWithRequestLangs({ applicationLang: 'lg-spa', dataLang: 'lg-spa' }, () =>
				getElementTools(target),
			),
			runWithRequestLangs({ applicationLang: 'lg-spa', dataLang: 'lg-spa' }, () =>
				getElementTools(target),
			),
		]);
		expect(first.tools.length).toBeGreaterThan(0);
		expect(first.tools.map((tool) => tool.name)).toEqual(second.tools.map((tool) => tool.name));
		for (const [index, tool] of first.tools.entries()) {
			expect(tool).not.toBe(second.tools[index] as object); // per-call copies
			expect(tool).toEqual(second.tools[index] as typeof tool); // same content
		}
	}, 30000);
});

// --- Layer 6: the structure-context CORE cache (ISO-02, P2-35) --------------

/**
 * THE REGRESSION THE 2026-07 REMEDIATION PRESCRIBED AND NOBODY WROTE.
 *
 * ISO-02 was accepted as "open (test-only; low risk)" with an exact
 * prescription: "two different-level principals reading the same tipo get
 * different `entry.tools` while cached core stays empty". No file in the tree
 * implemented it. A remediation accepted on the strength of a test that does
 * not exist is the failure mode this whole audit is about.
 *
 * AND THE RULE CHANGED UNDERNEATH IT — which is precisely what the prescribed
 * regression existed to detect. `structure_context.ts` now states the opposite
 * of the prescription's premise: "THE GATE IS **MODE**, NEVER PERMISSIONS ... a
 * `permissions >= 3` gate here would mean SUPERUSER-ONLY ... and would silently
 * empty every toolbar for every real user". Authorization is the per-user
 * `user_tools` membership that getElementTools applies itself, not the
 * element's level.
 *
 * So the regression is written against the invariant the module ACTUALLY holds,
 * stated in its own header: `coreCache` is keyed
 * `applicationLang_tipo_sectionTipo_mode` with NO user dimension, therefore
 * every field on the cached core must be user-INDEPENDENT. `tools` and
 * `buttons` are on that core. The day either becomes user-dependent, the key
 * must gain a user dimension — and this is the test that says so.
 */
describe('request isolation — structure-context core cache (ISO-02)', () => {
	const TIPO = 'test6836';
	const SECTION_TIPO = 'test2';

	test('two different-permission principals share the cached core BYTE-FOR-BYTE', async () => {
		clearStructureContextCache();
		// permissions 1 (read) then 2 (write): the widest real spread, since only
		// userId -1 ever reaches 3.
		const low = await runWithRequestLangs({ applicationLang: 'lg-eng', dataLang: 'lg-eng' }, () =>
			buildStructureContext({
				configFrom: { source: 'own', reason: 'unit-test' },
				tipo: TIPO,
				sectionTipo: SECTION_TIPO,
				mode: 'edit',
				lang: 'lg-eng',
				permissions: 1,
			}),
		);
		const high = await runWithRequestLangs({ applicationLang: 'lg-eng', dataLang: 'lg-eng' }, () =>
			buildStructureContext({
				configFrom: { source: 'own', reason: 'unit-test' },
				tipo: TIPO,
				sectionTipo: SECTION_TIPO,
				mode: 'edit',
				lang: 'lg-eng',
				permissions: 2,
			}),
		);
		expect(low, 'the fixture element did not resolve — the corpus moved').not.toBeNull();
		expect(high).not.toBeNull();

		// THE INVARIANT. The core is cached under a key with no user dimension, so
		// the cached fields must be identical for both principals. If a future
		// change makes `tools`/`buttons` depend on the actor, this diverges HERE —
		// which is the whole point, because in production it would instead mean one
		// user's toolbar served to another from a long-lived process.
		for (const field of ['tools', 'buttons', 'label', 'model', 'properties', 'css'] as const) {
			expect(
				JSON.stringify((high as unknown as Record<string, unknown>)[field]),
				`core field '${field}' differs between permission levels — coreCache has NO user ` +
					'dimension in its key, so this field can no longer be cached there. Either make ' +
					'it a per-call stamp (like entry.tools) or add a user dimension to the key.',
			).toBe(JSON.stringify((low as unknown as Record<string, unknown>)[field]));
		}
	}, 30000);

	test('the cache key still carries lang, tipo, section and mode — and no user', async () => {
		// Anti-vacuity for the test above: it only means something while the key is
		// user-free. If someone adds a user dimension, the equality assertion above
		// becomes trivially true and stops guarding anything — so the key's shape is
		// pinned here, and a change to it must be a deliberate edit in both places.
		const source = readFileSync(
			join(REPO_ROOT_ISO, 'src/core/resolve/structure_context.ts'),
			'utf8',
		);
		expect(source).toContain(
			'const cacheKey = `${currentApplicationLang()}_${tipo}_${sectionTipo}_${mode}`;',
		);
		// ...and the invariant is still written down where the next reader meets it.
		expect(source).toContain('this key MUST gain a user dimension');
	});
});
