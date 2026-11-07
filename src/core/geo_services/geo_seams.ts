/**
 * THE GEO SERVICES' TEST SEAMS — and the reason production has none.
 *
 * The text door (`fetchGuardedText`) takes injectable seams: the resolver that vets the
 * address and the socket that is dialled (`PinnedHopDeps`), and the limiter's clock,
 * sleep and timers. A gate needs them to drive the REAL guard against a loopback peer
 * with a fake clock. They are also exactly what a caller must never choose: whoever
 * replaces the resolver or the socket replaces the SSRF guard's pin and its address
 * vetting, so the entry point (`callGeoService(id, params)`) takes NO third argument —
 * there is no parameter to smuggle a transport through, by any import shape.
 *
 * The seams ride a scope instead, the shape the running job's signal already has
 * (`media/job_scope.ts`): `runWithGeoServiceSeams(deps, work)` sets them for `work`'s
 * dynamic extent and for nothing else, and `geoServiceSeams()` reads them (an empty
 * object outside a scope — production). An AsyncLocalStorage, never a module variable:
 * two gates, or a gate and a live call, can never hand each other a transport (the
 * isolation law, engineering/REQUEST_ISOLATION.md).
 *
 * WHO MAY SET THEM is the whole safety of this file, and it is pinned by a census, not
 * by this sentence: no module of `src/` or `tools/` binds `runWithGeoServiceSeams`, by
 * any route — a named or renamed import, a namespace, `export … from`, a barrel, a
 * literal `import()` or `require()`, a re-exported `const` — and a module that names this
 * file and loads something through a non-literal `import()` is refused too, since it
 * could be loading this (`ssrf_one_guard_tripwire`, the geo services section). Only
 * `call.ts` reads the scope, through `geoServiceSeams`, which sets nothing.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LimiterDeps } from '../harvest/origin_limiter.ts';
import type { PinnedHopDeps } from '../security/ssrf_guard.ts';

/** The seams of a call: the text door's, and the limiter's clock. */
export interface GeoServiceDeps extends PinnedHopDeps {
	/** The limiter's clock, sleep and timers. */
	readonly limiter?: LimiterDeps;
}

const NO_SEAMS: GeoServiceDeps = Object.freeze({});

const seamStore = new AsyncLocalStorage<GeoServiceDeps>();

/** Run `work` with `deps` as the seams of every geo service call inside it. TESTS ONLY (see the header). */
export function runWithGeoServiceSeams<T>(deps: GeoServiceDeps, work: () => T): T {
	return seamStore.run(deps, work);
}

/** The seams in scope; none (the real resolver, socket and clock) outside `runWithGeoServiceSeams`. */
export function geoServiceSeams(): GeoServiceDeps {
	return seamStore.getStore() ?? NO_SEAMS;
}
