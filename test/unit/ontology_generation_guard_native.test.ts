/**
 * Build-then-set ontology caches must not re-seed a cache cleared while their
 * SELECT was in flight (TODO-080: an ontology css edit kept serving the pre-edit
 * css until the next write). getNode is the shared door every context build
 * reads through, buildCore the context core cache that carries `css`; the
 * generation counter lives in the invalidation hub.
 *
 * Read-only: reads the core node `dd1` (shipped by the install seed), no writes.
 */

import { describe, expect, test } from 'bun:test';
import {
	clearOntologyDerivedCaches,
	currentOntologyGeneration,
} from '../../src/core/ontology/cache_invalidation.ts';
import { getNode } from '../../src/core/ontology/resolver.ts';
import { buildStructureContextCore } from '../../src/core/resolve/structure_context.ts';

const TIPO = 'dd1';

describe('ontology generation guard', () => {
	test('every clear bumps the generation', async () => {
		const before = currentOntologyGeneration();
		await clearOntologyDerivedCaches();
		expect(currentOntologyGeneration()).toBe(before + 1);
	});

	test('getNode across a clear serves the row but does NOT memoize it', async () => {
		await clearOntologyDerivedCaches();
		const inflight = getNode(TIPO); // SELECT in flight…
		await clearOntologyDerivedCaches(); // …an ontology write clears the caches
		const raced = await inflight;
		expect(raced?.tipo).toBe(TIPO);

		const fresh = await getNode(TIPO);
		expect(fresh).not.toBe(raced); // re-read, the raced row was not cached

		const cached = await getNode(TIPO);
		expect(cached).toBe(fresh); // control: no clear in between -> memoized
	});

	test('a context core built across a clear is served but NOT memoized', async () => {
		await clearOntologyDerivedCaches();
		const inflight = buildStructureContextCore(TIPO, TIPO, 'edit');
		await clearOntologyDerivedCaches();
		const raced = await inflight;
		expect(raced).not.toBeNull();

		const fresh = await buildStructureContextCore(TIPO, TIPO, 'edit');
		expect(fresh).not.toBe(raced);

		const cached = await buildStructureContextCore(TIPO, TIPO, 'edit');
		expect(cached).toBe(fresh);
	});

	test('a clear AFTER getNode returned (mid-build) still blocks the core set', async () => {
		await clearOntologyDerivedCaches();
		await getNode(TIPO); // warm: buildCore's first await resolves from cache
		const inflight = buildStructureContextCore(TIPO, TIPO, 'list');
		await Promise.resolve(); // let buildCore pass its first await
		await clearOntologyDerivedCaches();
		const raced = await inflight;
		const fresh = await buildStructureContextCore(TIPO, TIPO, 'list');
		expect(fresh).not.toBe(raced);
	});
});
