/**
 * A scripted site for the gates that drive `harvestFetch` (`HarvestDeps.hop`, our
 * clock): no network, no wait. Each behaviour beyond a plain answer is opt-in,
 * so a gate keeps the fake it was written against: a redirect needs a route's
 * `location`, the door's `acceptBody` and the byte ceiling are honoured only
 * when the site asks for them.
 */

import { DedaloError } from '../../../../src/core/errors/index.ts';
import type { HarvestDeps } from '../../../../src/core/harvest/harvest.ts';
import { clearPacingForTests } from '../../../../src/core/harvest/pacing.ts';
import { clearRobotsCache } from '../../../../src/core/harvest/robots.ts';
import type {
	PinnedHopRequest,
	PinnedHopResponse,
} from '../../../../src/core/security/ssrf_guard.ts';

export interface ScriptedRoute {
	status: number;
	/** The content-type header, when the route sends one. */
	type?: string;
	body?: string | Uint8Array;
	/** Where a 3xx points; without it a 3xx is a plain answer. */
	location?: string;
}

export interface ScriptedSite {
	deps: HarvestDeps;
	/** Every URL the door requested, in order. */
	sent: string[];
	/** The byte ceiling each request carried, by URL. */
	ceilings: Map<string, number>;
	/** URLs whose body the door told the site not to send (`acceptBody`). */
	skipped: string[];
}

export interface ScriptedSiteOptions {
	/** Ask the door's `acceptBody` before sending a body, as the pinned primitive does. */
	acceptBody?: boolean;
	/** Refuse a body over the request's `maxBytes`, as the pinned primitive does. */
	bodyCap?: boolean;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** A site answering by URL the way the pinned primitive would. */
export function scriptedSite(
	routes: Record<string, ScriptedRoute>,
	options: ScriptedSiteOptions = {},
): ScriptedSite {
	const sent: string[] = [];
	const ceilings = new Map<string, number>();
	const skipped: string[] = [];
	let now = 1_000_000;
	const hop = async (request: PinnedHopRequest): Promise<PinnedHopResponse> => {
		const url = request.url.toString();
		sent.push(url);
		ceilings.set(url, request.maxBytes);
		const answer = routes[url] ?? { status: 404 };
		const headers = new Headers();
		if (answer.type !== undefined) headers.set('content-type', answer.type);
		const location = REDIRECTS.has(answer.status) ? (answer.location ?? null) : null;
		const base = { status: answer.status, headers, location, truncated: false };
		if (location !== null) return { ...base, bytes: new Uint8Array(0), bodySkipped: true };
		if (options.acceptBody === true && request.acceptBody?.(answer.status, headers) === false) {
			skipped.push(url);
			return { ...base, bytes: new Uint8Array(0), bodySkipped: true };
		}
		const body =
			typeof answer.body === 'string'
				? new TextEncoder().encode(answer.body)
				: (answer.body ?? new Uint8Array(0));
		if (options.bodyCap === true && body.byteLength > request.maxBytes) {
			throw new DedaloError('security.outbound_failed', {
				coordinates: { reason: 'body_cap', max_bytes: request.maxBytes },
			});
		}
		return { ...base, bytes: body, bodySkipped: false };
	};
	const deps: HarvestDeps = {
		hop,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		setTimer: () => {},
	};
	return { deps, sent, ceilings, skipped };
}

/** Robots verdicts and the pace are process-wide: cleared around every test. */
export function resetHarvestState(): void {
	clearRobotsCache();
	clearPacingForTests();
}
