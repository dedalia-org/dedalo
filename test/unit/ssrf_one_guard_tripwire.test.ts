/**
 * ONE OUTBOUND GUARD, AND NO NEW DOOR BESIDE IT (P1-26 / CARRY-10 / CARRY-14).
 *
 * `src/core/security/ssrf_guard.ts` is the hardened primitive: it RESOLVES the
 * hostname and vets every address, and bounds both the wait and the read. What
 * it does with a redirect depends on the door (engineering/OUTBOUND_SPEC.md):
 * the single-call door (`fetchGuardedText`) REFUSES one, because a 3xx
 * re-chooses the target; the pinned hop (`fetchPinnedHop`) RETURNS it unread,
 * so the harvesting door (`src/core/harvest/`) can put the new target through
 * the whole policy again before a socket opens to it.
 *
 * WHO MAY HOLD WHICH DOOR is censused here too, by IMPORT GRAPH: the pinned hop
 * has exactly one production importer (the harvest redirect loop), that loop
 * (`followVetted`) exactly two (`harvestFetch` and the robots.txt fetch), and a tool
 * reaches a raw door only by a written, reasoned exemption — a tool harvests
 * through `harvestFetch`. Before this census both rules were prose. The harvesting
 * door's second, INTERACTIVE profile (`interactiveFetch`: no robots.txt, a cap
 * instead of the serial pace — OUTBOUND_SPEC.md §3.1) is censused as a door of its
 * own: no tool holds it, and a core module holds it only by a reasoned row
 * (`INTERACTIVE_IMPORTERS`, exact both ways).
 *
 * Two doors carried private four-string blocklists — `localhost`, `127.0.0.1`,
 * `::1`, `169.254.169.254`, plus a private-range regex — and the transcriber's
 * file SAID it was a copy of the translator's ("duplicated here rather than
 * widening another module's surface"). Both missed `127.0.0.2`, `0.0.0.0`,
 * decimal-integer IPv4, `anything.localhost`, every DNS NAME that resolves
 * inward, and the redirect hop; their `::1` arm was DEAD CODE, because
 * `new URL('http://[::1]/').hostname` is `[::1]` WITH the brackets.
 *
 * A SOCKET, NOT A SPELLING — the lesson `external_outbound_tripwire` already
 * learned, relearned here the hard way. THE FIRST DRAFT OF THIS FILE pinned the
 * three literal spellings the deleted guards used, and an adversarial review
 * put the whole blocklist back with the variable renamed `host` → `h` and the
 * regex alternation reordered: 11 pass, 0 fail. That gate forbade one
 * historical spelling of the defect, not the defect. What a new outbound door
 * CANNOT avoid is opening a socket, so that is what is counted.
 *
 * SHRINK-ONLY, NOT A CLEAN BILL. The exempt list below is the burn-down CARRY-14
 * names, frozen: these sites predate the guard and most still lack its timeout,
 * byte ceiling and redirect refusal. Freezing them says "no NEW door", not "these
 * are fine". An entry may only be REMOVED.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { basename, dirname, join as joinPosix, normalize as normalizePosix } from 'node:path/posix';
import { parse } from '@babel/parser';
import { Glob } from 'bun';
import type { DedaloError } from '../../src/core/errors/index.ts';
import * as harvestModule from '../../src/core/harvest/harvest.ts';
import { extractRfc6052Ipv4, packCidr } from '../../src/core/security/ip_address.ts';
import {
	type AddressLookup,
	assertPublicUrl,
	claimedIpv4s,
	isAddressRefusal,
	isLoopbackHost,
	isPrivateIp,
	isPublicUrl,
	nat64DiscoveryState,
	SSRF_REFUSAL_KINDS,
	setNat64DiscoveryForTests,
} from '../../src/core/security/ssrf_guard.ts';
import { isSafeLocalAsrUrl } from '../../src/core/tools/transcription_local_asr.ts';
// String-literal aware. The regex version this replaced ate 71 lines of
// dd_mcp_api.ts, because the literal 'image/*' opens a block comment that runs
// to the next `*/` — and a marker planted in that window scanned as absent.
import { isNameOnly, patternNames, readsProperty, walkAst } from '../helpers/ast_walk.ts';
import { stripComments } from '../helpers/strip_comments.ts';

/**
 * No DECLARED NAT64 prefix while the behavioural cases run: pinned to '' (a deleted
 * key falls back to ../private/.env through readEnv), so an operator's
 * `DEDALO_NAT64_PREFIXES` — a typo fails every IPv6 closed — cannot change what
 * they judge. The guard's own gate (ssrf_guard.test.ts) does the same.
 */
const NAT64_SETTING = 'DEDALO_NAT64_PREFIXES';
const originalNat64 = process.env[NAT64_SETTING];
beforeEach(() => {
	process.env[NAT64_SETTING] = '';
});
afterEach(() => {
	if (originalNat64 === undefined) delete process.env[NAT64_SETTING];
	else process.env[NAT64_SETTING] = originalNat64;
});

const REPO_ROOT = join(import.meta.dir, '..', '..');
const GUARD = 'src/core/security/ssrf_guard.ts';
/** The harvesting door — what a tool that reads another site's pages imports. */
const HARVEST_DOOR = 'src/core/harvest/harvest.ts';

/**
 * The paired private agent channel — the FOURTH door (engineering/OUTBOUND_SPEC.md §2.1).
 * The publication agent is private BY DESIGN, so the guard would refuse it; the door is
 * named and censused here as a door (`PRIVATE_CHANNEL_DOORS`, the import-graph rows
 * below), never parked in the `EXEMPT` burn-down.
 */
const AGENT_CHANNEL = 'src/core/publication_host/transport.ts';

/**
 * An outbound CALL — `await fetch(`, `= fetch(`, `return fetch(`, `(fetch(`.
 * Deliberately not a bare `fetch(`: `Bun.serve({ fetch(request) {…} })` is a
 * handler DEFINITION — the INBOUND direction — and flagging it makes the gate
 * cry wolf in `src/server.ts`, which is how a gate gets deleted. Hence `[ \t]`
 * and not `\s`: an earlier draft spanned the newline after the preceding
 * property's comma and matched that handler anyway. `=>` is listed before `=`
 * so the arrow in `((t, i) => fetch(t, i))` — src/external's real door — is not
 * read as an assignment and missed.
 */
const OUTBOUND_CALL = /(?:await|return|=>|=|\(|\?\?)[ \t]*fetch[ \t]*\(/;

/**
 * `fetch` handed over as a VALUE — `deps.fetch ?? fetch`, `fetchImpl: fetch`,
 * `impl: typeof fetch = fetch` — and called later under another name. That is a
 * socket the call pattern above cannot see: measured 2026-09-29, six modules
 * dialled out this way unseen (the four model providers, the error-report relay,
 * the update reachability probe). Not a key (`fetch:`), not a member (`x.fetch`),
 * not a type (`typeof fetch`); run on code with literals BLANKED, so a sentence
 * saying "fetch" is not a socket.
 */
const OUTBOUND_VALUE = /(?<![\w$.])(?<!typeof\s+)fetch(?![\w$])(?!\s*(?:\(|\??:))/;

/**
 * The frozen burn-down (CARRY-14). Each reason says what the site talks to and
 * why it has not moved yet — never "it is safe".
 */
const EXEMPT: Record<string, string> = {
	'src/external/transport.ts':
		'THE external subsystem’s single door, and it already carries the fuller contract ' +
		'(kill switches, host allowlist, SSRF guard, socket pin, byte ceiling, breaker, ' +
		'concurrency bound). Policed by its own external_outbound_tripwire.',
	'tools/tool_sitebuilder/server/daemon_client.ts':
		'Speaks to the site_builder daemon over a UNIX SOCKET on this machine — there is no ' +
		'hostname to resolve and no network hop to guard. Operator-configured, never caller-supplied.',
	'src/core/area_maintenance/widgets/site_builder_status.ts':
		'Same site_builder daemon on this machine, same unix-socket transport, dialled from ' +
		'the maintenance widget. No hostname to resolve, no network hop to guard.',
	'src/core/update/smoke_boot.ts':
		'Dials the QUARANTINE server this process just spawned, over its own unix socket, at ' +
		'the literal http://localhost/health. Loopback is the entire purpose.',
	'src/core/ai/model_fetch.ts':
		'Model-weight downloads from the operator-configured hub. NOT YET on the guarded ' +
		'transport: needs the streamed byte ceiling and typed timeout (CARRY-14).',
	'src/core/geoip/download.ts':
		'GeoIP database download from a pinned vendor URL; already sets redirect:"error", but ' +
		'has no resolve-and-vet step. NOT YET on the guarded transport (CARRY-14).',
	'src/core/update/code_download.ts':
		'Release-archive download from the configured code server; already sets ' +
		'redirect:"error". NOT YET on the guarded transport (CARRY-14).',
	'src/core/ontology/data_io_import.ts':
		'Ontology/code import from a configured master. NOT YET on the guarded transport ' +
		'(CARRY-14) — the largest remaining one, since the URL is operator-entered.',
	// SEEN 2026-09-29, when the census learned OUTBOUND_VALUE — pre-existing
	// sockets it had been blind to, not new doors. Same burn-down, same rule.
	'src/core/update/status.ts':
		'advertisedUrlReachableCheck: a code server probes its OWN advertised release URL ' +
		'(operator config) to prove consumers can reach it — which may legitimately be a LAN ' +
		'address (the docker museum case), so the public-address guard cannot apply. ' +
		'redirect:"error" and a timeout at the call.',
	'src/ai/agent/openai_compat_provider.ts':
		'The agent’s model endpoint, operator-configured and commonly an on-premise sidecar ' +
		'on loopback or the LAN, which the public-address guard would refuse. Signal + idle ' +
		'timer at the call; NOT byte-capped (CARRY-14).',
	'src/ai/rag/llm_provider.ts':
		'The RAG answer model endpoint, operator-configured (commonly a local Ollama the guard ' +
		'would refuse). Signal + timeout at the call; NOT byte-capped (CARRY-14).',
	'src/ai/rag/embedding_provider.ts':
		'The embedding endpoint, operator-configured (commonly a local Ollama the guard would ' +
		'refuse). Signal + timeout at the call; NOT byte-capped (CARRY-14).',
	'src/ai/rag/multimodal_embedding_provider.ts':
		'The multimodal embedding endpoint, operator-configured (endpointIsLocal names the ' +
		'local case the guard would refuse). Signal + timeout at the call; NOT byte-capped (CARRY-14).',
	'tools/tool_error_report/server/index.ts':
		'Relays an error report to the operator-configured master (masterUrlAllowed: https, ' +
		'or loopback http). Signal + timeout at the call; no resolve-and-vet and NOT ' +
		'byte-capped — NOT YET on the guarded transport (CARRY-14).',
};

/**
 * Doors that dial a legitimately PRIVATE destination with a policy of their own. Not
 * burn-down: each is a permanent door of `engineering/OUTBOUND_SPEC.md` §2, with its own
 * gate. A row whose file stops dialling is stale (red), and a door is never ALSO exempt.
 */
const PRIVATE_CHANNEL_DOORS: Record<string, string> = {
	[AGENT_CHANNEL]:
		'THE paired private agent channel: dials ONLY the registry entry of a paired publication ' +
		'agent — https to the registered host:port with mTLS (client certificate from the engine ' +
		'bundle, the CA pinned, rejectUnauthorized on) or the registered unix socket — on the ' +
		'agent’s closed route table, redirects refused, total deadline + idle bound, shared capped ' +
		'reader. Policed by publication_host_door_tripwire and publication_host_transport_native.',
};

/** `code`: comments stripped, literals kept. `blanked`: literal bodies blanked too. */
function sourceFiles(): { file: string; code: string; blanked: string }[] {
	const files: { file: string; code: string; blanked: string }[] = [];
	for (const dir of ['src', 'tools'] as const) {
		for (const match of new Glob('**/*.ts').scanSync({ cwd: join(REPO_ROOT, dir) })) {
			if (match.endsWith('.test.ts')) continue;
			const file = relative(REPO_ROOT, join(REPO_ROOT, dir, match));
			const source = readFileSync(join(REPO_ROOT, file), 'utf8');
			const blanked = stripComments(source, { blankStrings: true, blankRegexBodies: true });
			files.push({ file, code: stripComments(source), blanked });
		}
	}
	return files.sort((a, b) => a.file.localeCompare(b.file));
}

describe('outbound SSRF: one guard', () => {
	const scanned = sourceFiles();
	const raw = scanned
		.filter((entry) => entry.file !== GUARD)
		.filter((entry) => OUTBOUND_CALL.test(entry.code) || OUTBOUND_VALUE.test(entry.blanked))
		.map((entry) => entry.file);

	test('the scan actually sees the tree (anti-vacuity)', () => {
		// A glob that silently matched nothing would make every census below pass.
		expect(scanned.length).toBeGreaterThan(400);
		expect(scanned.some((entry) => entry.file === GUARD)).toBe(true);
		// And the stripper must not blind it: the file whose 'image/*' literal ate
		// 71 lines under the old regex stripper must still scan at full length.
		const mcp = scanned.find((e) => e.file.endsWith('dd_mcp_api.ts'));
		const rawText = readFileSync(join(REPO_ROOT, mcp?.file ?? GUARD), 'utf8');
		expect(mcp?.code.split('\n').length).toBe(rawText.split('\n').length);
	});

	test('no NEW module opens an outbound socket of its own', () => {
		const offenders = raw.filter(
			(file) => EXEMPT[file] === undefined && PRIVATE_CHANNEL_DOORS[file] === undefined,
		);
		expect(
			offenders,
			'A new outbound door skips the resolve-and-vet, the redirect policy, the timeout ' +
				'and the byte cap. Harvesting pages from another site (redirects, robots.txt, ' +
				`pacing): harvestFetch in ${HARVEST_DOOR}. One API call to a public service: ` +
				`fetchGuardedText in ${GUARD}. If it genuinely can be neither (a unix socket, a ` +
				'deliberate loopback dial) add it to EXEMPT with a reason saying so. ' +
				`engineering/OUTBOUND_SPEC.md names the doors.\n  ${offenders.join('\n  ')}`,
		).toEqual([]);
	});

	test('the burn-down list may only SHRINK', () => {
		// An exemption for a file that no longer opens a socket is a hole nobody
		// is looking at any more — and hides that the debt was actually paid.
		const stale = Object.keys(EXEMPT).filter((file) => !raw.includes(file));
		expect(
			stale,
			'These files no longer make a raw outbound call — DELETE their exemptions.\n  ' +
				stale.join('\n  '),
		).toEqual([]);
		for (const [file, reason] of Object.entries(EXEMPT)) {
			expect(reason.length, `${file}: an exemption needs a real reason`).toBeGreaterThan(80);
		}
	});

	test('a private channel door is a DOOR, not a burn-down row, and still dials', () => {
		for (const [file, reason] of Object.entries(PRIVATE_CHANNEL_DOORS)) {
			expect(EXEMPT[file], `${file} is a door — never also a burn-down exemption`).toBeUndefined();
			expect(raw, `${file} no longer opens its socket — delete its row`).toContain(file);
			expect(reason.length, `${file}: a door row needs a real reason`).toBeGreaterThan(80);
		}
	});

	test('the two migrated doors went through the guard and stayed there', () => {
		for (const door of ['src/core/tools/translation.ts', 'src/core/tools/transcription_asr.ts']) {
			const code = stripComments(readFileSync(join(REPO_ROOT, door), 'utf8'));
			expect(code, `${door} no longer routes through fetchGuardedText`).toContain(
				'fetchGuardedText(',
			);
			expect(code, `${door} opened a raw socket again`).not.toMatch(OUTBOUND_CALL);
		}
	});

	test('the guard itself still resolves, has a redirect policy per door and bounds the read', () => {
		// Coarse by design: that each door ENFORCES its policy (the single-call door
		// refuses a 3xx, the pinned hop returns it unread) is asserted per function,
		// and driven, in outbound_fetch_tripwire.test.ts.
		const guard = readFileSync(join(REPO_ROOT, GUARD), 'utf8');
		expect(guard).toContain("redirect: 'error'");
		expect(guard).toContain("redirect: 'manual'");
		expect(guard).toContain('maxBytes');
		expect(guard).toContain('AbortController');
		expect(guard).toMatch(/lookup|resolve/);
	});
});

// ---------------------------------------------------------------------------
// WHO HOLDS WHICH DOOR — an IMPORT-GRAPH census, not a grep for a name.
//
// The socket census above proves no module dials out BESIDE the guard. It cannot
// see which module dials THROUGH which door, and two rules depend on that:
//   - `fetchPinnedHop` returns a redirect unread and vets only the ADDRESS. Every
//     other rule a new target must pass again (scheme, https → http, the host
//     allowlist, robots.txt, pacing, the hop limit) lives in ITS CALLER. A second
//     caller is a second redirect loop, and the first one that forgets a rule is
//     an open redirect into an institution's harvester.
//   - A tool reading another site's pages owes robots.txt and a polite pace,
//     which only `harvestFetch` pays. A tool on a raw door skips both silently —
//     and so does one on `followVetted`, whose per-hop robots/pacing check is
//     whatever its caller passes, so it is censused as a door of its own.
//
// A binding is followed, not a spelling: named, renamed, namespace, default,
// `export … from`, `export *`, a top-level `const x = door` re-exported, a
// literal `import()` / `require()` — through any number of re-exporting
// modules. What it deliberately does NOT follow is a WRAPPER (`function get(u)
// { return fetchGuardedText(u) }`): a wrapper is a new function with its own
// contract, reviewed where it is written, and `harvestFetch` is exactly such a
// wrapper around the pinned hop.
// ---------------------------------------------------------------------------

/** The raw doors whose holders are censused. Policy helpers (isPrivateIp, assertPublicUrl…) are free to import. */
const RAW_DOORS = ['fetchPinnedHop', 'fetchBoundedText', 'fetchGuardedText'] as const;

/** The harvest redirect loop — the half-door between the pinned hop and `harvestFetch`. */
const FOLLOW = 'src/core/harvest/follow.ts';

/**
 * `followVetted` is a DOOR too, and censused as one. It vets every hop's URL, but
 * robots.txt and pacing are whatever its CALLER passes as `beforeHop` — the robots
 * fetch itself passes a no-op. A tool importing it gets redirects followed and a
 * pinned socket with neither, and no socket census sees it (it spells no `fetch(`).
 */
const FOLLOW_DOOR = 'followVetted';

/**
 * The harvesting door's second, INTERACTIVE profile (engineering/OUTBOUND_SPEC.md §3.1):
 * the same per-hop vetting with NO robots.txt and a per-origin cap in place of the
 * serial pace. It exists for a request a person is waiting for that a CORE route
 * relays (a map tile), so it is a door of its own — a tool holding it would skip
 * robots.txt and the default pace silently, the exact thing `harvestFetch` is for.
 * A profile is a module-private value, so the entry point is the whole surface.
 */
const INTERACTIVE_DOOR = 'interactiveFetch';

/**
 * The agent channel's two doors. `agentRequest` reads the host's TLS material itself and is
 * what production dials through; `dialAgent` takes the material from its caller and exists
 * for the door's own native gate — no production module may hold it.
 */
const AGENT_CHANNEL_DOORS = ['agentRequest', 'dialAgent'] as const;

/**
 * The ONLY production holders of `agentRequest`. Exact in both directions, like
 * `PINNED_HOP_IMPORTERS`: the holder owes the pairing proof BEFORE it passes a bearer
 * (engineering/PUBLICATION_HOST_SPEC.md §2 rule 3), which the door cannot do for it.
 */
const AGENT_CHANNEL_IMPORTERS: Record<string, string> = {
	'src/core/publication_host/agent_client.ts':
		'THE publication-host client: proves the pairing (local token ⇒ registry fingerprint, then the live /health fingerprint) before any bearer; mutations re-prove live on every call; reads only under a proof keyed on fingerprint + address (publication_host_agent_client_native).',
};

/** Every door-carrying module the census starts from, with the doors it hands out. */
const DOOR_SEEDS: Record<string, readonly string[]> = {
	[GUARD]: RAW_DOORS,
	[FOLLOW]: [FOLLOW_DOOR],
	[AGENT_CHANNEL]: AGENT_CHANNEL_DOORS,
	[HARVEST_DOOR]: [INTERACTIVE_DOOR],
};

/**
 * The reach of a module that names a door-carrying module AND loads something
 * through a NON-literal `import()`. The census cannot know what that loads, so
 * it reports the module instead of guessing it clean.
 */
const OPAQUE = '<non-literal import()>';

/**
 * The ONLY production importer of `fetchPinnedHop`. Exact in both directions: a
 * second importer is refused, and this row fails if its file stops importing it.
 * (Inside the guard, `fetchGuardedText` uses the hop ONCE and refuses any `Location`
 * — no redirect loop, so not a second caller in the sense above.)
 */
const PINNED_HOP_IMPORTERS: Record<string, string> = {
	'src/core/harvest/follow.ts':
		'THE redirect loop of the harvesting door: for EVERY hop it re-runs the scheme, the ' +
		'https → http refusal, the caller’s host policy, the URL length ceiling and the ' +
		'caller’s robots/pacing check before handing the hop to fetchPinnedHop, and stops at ' +
		'MAX_REDIRECTS.',
};

/**
 * The ONLY importers of `followVetted`. Exact in both directions, like
 * `PINNED_HOP_IMPORTERS`: each passes its own per-hop gate, and a third is refused.
 */
const FOLLOW_VETTED_IMPORTERS: Record<string, string> = {
	'src/core/harvest/harvest.ts':
		'harvestFetch: THE harvesting door. Its beforeHop is hopGate — robots.txt for the ' +
		'hop’s origin, then that origin’s paced turn, released with the hop’s Retry-After.',
	'src/core/harvest/robots.ts':
		'The robots.txt fetch itself, under one fixed policy: it IS the robots check (so its ' +
		'beforeHop is a no-op) and is not paced — RFC 9309 §2.3.1.2 asks redirects followed.',
};

/**
 * A core route's row. Not a free-text excuse: each field is something a gate below CHECKS
 * (`interactiveRouteProblems`), because a row that only had to exist would admit any text,
 * including none.
 */
interface InteractiveRoute {
	/** What the route does for the duties below, in prose (at least a sentence's worth). */
	readonly reason: string;
	/** The route's OWN gate — `test/unit/<route>_native.test.ts` — which drives those duties. */
	readonly gate: string;
	/** The route module's runtime exports, ALL of them: route handlers, never a function that takes a URL. */
	readonly handlers: readonly string[];
}

/**
 * The ONLY production holder of `interactiveFetch`. Exact in both directions, like
 * `AGENT_CHANNEL_IMPORTERS`: the holder relays a request a person is waiting for and
 * owes the rest of the contract itself (engineering/OUTBOUND_SPEC.md §3.1) — its request
 * names a stored source, never a URL a client wrote; it names truthfully who chose the
 * host (`addressFrom`: an editor's address is `'stored'`, so it cannot take the whole
 * global budget); it checks the session and the read permission BEFORE it fetches or
 * answers from a cache; it maps EVERY failure of the door to ONE typed refusal for its
 * reader (the public `harvest.*` details name a site and a media type, which would make
 * the route an oracle for which port or service answered); it passes the origin's spacing
 * on every request to that origin (a start owes its spacing to the ones after it — built by
 * `relayRequest`, which carries its own gate because the route's registry owes none yet); and it
 * exports a route handler, never a function that takes a URL (the census does not follow
 * wrappers, so a URL-taking export would hand the door to anyone who imports THAT). The
 * door itself enforces what it can: the scheme's own port on every hop, and a job signal
 * in scope (`harvest_door_native`).
 *
 * A row is `{ reason, gate, handlers }` and is CHECKED, not read: the route module's
 * runtime exports must be exactly `handlers`, and `gate` must exist, import the route,
 * name every handler and carry a real number of tests (`interactiveRouteProblems`, driven
 * on a synthetic tree below, since this table is empty today). At most ONE row.
 *
 * ONE row: the core route that relays map tiles (`api/map_tile.ts`), with its own gate. A
 * row whose module stops holding the door is stale, and fails below.
 */
const INTERACTIVE_IMPORTERS: Record<string, InteractiveRoute> = {
	'src/core/api/map_tile.ts': {
		reason:
			'THE map tile proxy. The request names a stored source, an ontology default or a ' +
			'closed built-in id and never a URL; the session, the component grant and the record ' +
			'scope are checked BEFORE the address is built and before the tile memory is read; ' +
			'`addressFrom` is truthful (an editor-written address is `stored`); the hosts allowlist ' +
			'is the template’s host; the origin’s spacing is put on every request by `relayRequest` ' +
			'(geo/tile_proxy/relay_request.ts), whose own gate drives it through the real door with a ' +
			'synthetic non-zero spacing because no registry row owes one today; the call runs under ' +
			'the signal of its flight, stopped when the last viewer waiting on it has gone; a person ' +
			'is held to a budget of provider calls before the door sees them; the answer must be a ' +
			'2xx of the exact image type whose bytes begin like it; EVERY failure of the door is one ' +
			'`external.transport` refusal; the module exports its handler and nothing that takes a URL.',
		gate: 'test/unit/map_tile_proxy_native.test.ts',
		handlers: ['handleMapTile'],
	},
};

/** The spec says ONE core route (§3.1): a second relay is a change to the spec, not a row. */
const MAX_INTERACTIVE_ROUTES = 1;
/** A `reason` shorter than this says nothing about the route's duties. */
const MIN_ROUTE_REASON_LENGTH = 40;
/**
 * A route gate carries at least this many tests. The route's contract has more than ten
 * clauses (§3.1), so a gate with fewer cannot be driving each; `gate_vacuity_tripwire` is
 * what asks whether a test asserts anything.
 */
const MIN_ROUTE_GATE_TESTS = 10;
/** The shape of a route's own gate: a native gate of its own, in the unit tier. */
const ROUTE_GATE_PATH = /^test\/unit\/[a-z0-9_]+_native\.test\.ts$/;
/** Gates of the harvesting door itself — the census's, never a route's. */
const HARVEST_DOOR_GATES: ReadonlySet<string> = new Set([
	'test/unit/ssrf_one_guard_tripwire.test.ts',
	'test/unit/harvest_door_native.test.ts',
	'test/unit/origin_limiter_native.test.ts',
	'test/unit/module_state_tripwire.test.ts',
]);

/**
 * Tools hold NO raw door. This was a SHRINK-ONLY list of reasoned rows; its last
 * row (tool_import_rdf, which refused the 303/301 every linked-data server answers
 * with) moved to `harvestFetch` on 2026-10-01, and a shrink-only list at zero stays
 * at zero. A tool harvests through `harvestFetch`; a single API call to a
 * configured service belongs in engine code (`src/core/tools/translation.ts`).
 */

type AstNode = { type: string; [key: string]: unknown };

/** One runtime binding a module takes from another. `imported` '*' = the whole namespace. */
interface ImportLink {
	specifier: string;
	imported: string;
	local: string | null;
}

/** `export { a as b } from`, `export * as ns from` (imported '*'), `export * from` (exported '*'). */
interface ReExportLink {
	specifier: string;
	imported: string;
	exported: string;
}

/** A local binding (or a namespace member of one) exported under a name. */
interface LocalRef {
	local: string;
	member: string | null;
}

interface ModuleLinks {
	imports: ImportLink[];
	reexports: ReExportLink[];
	localExports: Array<LocalRef & { exported: string }>;
	/** Top-level `const x = y` / `const x = ns.y` — one module-internal rename. */
	aliases: Map<string, LocalRef>;
	opaque: boolean;
}

type Exposure = Map<string, Set<string>>;

interface CensusState {
	sources: ReadonlyMap<string, string>;
	/** The door-carrying modules the census starts from (`DOOR_SEEDS` unless told otherwise). */
	seeds: Readonly<Record<string, readonly string[]>>;
	links: Map<string, ModuleLinks>;
	/** For each door-CARRYING module: export name → the doors it hands out. */
	exposure: Map<string, Exposure>;
}

/** An identifier or string-literal name (`import { 'x' as y }` is legal). */
function nameOf(node: unknown): string {
	const named = node as { name?: string; value?: string };
	return named.name ?? named.value ?? '';
}

/** A module specifier written as a literal, or null. */
function literalSpecifier(node: unknown): string | null {
	const literal = node as AstNode | undefined;
	if (literal?.type === 'StringLiteral') return literal.value as string;
	const quasis = literal?.quasis as Array<{ value: { cooked: string } }> | undefined;
	if (literal?.type === 'TemplateLiteral' && (literal.expressions as unknown[]).length === 0) {
		return quasis?.[0]?.value.cooked ?? null;
	}
	return null;
}

/**
 * `x`, `ns.x`, `ns['x']`, and any of them under a type assertion — else null.
 * `ns[key]` with a key the scanner cannot read is the WHOLE namespace: the
 * census cannot know which member it is, so it assumes every one.
 */
function refOf(expression: unknown): LocalRef | null {
	const node = expression as AstNode | null;
	if (node === null || node === undefined) return null;
	if (/^TS(As|Satisfies|NonNull)Expression$|^ParenthesizedExpression$/.test(node.type)) {
		return refOf(node.expression);
	}
	if (node.type === 'Identifier') return { local: node.name as string, member: null };
	const object = node.object as AstNode | undefined;
	if (node.type !== 'MemberExpression' || object?.type !== 'Identifier') return null;
	const member = node.computed === true ? literalSpecifier(node.property) : nameOf(node.property);
	return { local: object.name as string, member };
}

function collectImport(statement: AstNode, links: ModuleLinks): void {
	if (statement.importKind === 'type') return; // erased at compile time: reaches nothing
	const specifier = (statement.source as AstNode).value as string;
	for (const binding of statement.specifiers as AstNode[]) {
		if (binding.importKind === 'type') continue;
		const imported =
			binding.type === 'ImportSpecifier'
				? nameOf(binding.imported)
				: binding.type === 'ImportDefaultSpecifier'
					? 'default'
					: '*';
		links.imports.push({ specifier, imported, local: nameOf(binding.local) });
	}
}

function collectDeclaredRefs(
	declaration: AstNode | null,
	links: ModuleLinks,
	exported: boolean,
): void {
	if (declaration?.type !== 'VariableDeclaration') return;
	for (const declarator of declaration.declarations as AstNode[]) {
		const id = declarator.id as AstNode;
		const ref = refOf(declarator.init);
		if (id.type !== 'Identifier' || ref === null) continue;
		links.aliases.set(id.name as string, ref);
		if (exported) links.localExports.push({ ...ref, exported: id.name as string });
	}
}

function collectExportNamed(statement: AstNode, links: ModuleLinks): void {
	if (statement.exportKind === 'type') return;
	const source = statement.source as AstNode | null;
	for (const binding of (statement.specifiers ?? []) as AstNode[]) {
		if (binding.exportKind === 'type') continue;
		const exported = nameOf(binding.exported);
		const imported = binding.type === 'ExportNamespaceSpecifier' ? '*' : nameOf(binding.local);
		if (source !== null) {
			links.reexports.push({ specifier: source.value as string, imported, exported });
		} else {
			links.localExports.push({ local: imported, member: null, exported });
		}
	}
	collectDeclaredRefs(statement.declaration as AstNode | null, links, true);
}

function collectStatement(statement: AstNode, links: ModuleLinks): void {
	if (statement.type === 'ImportDeclaration') collectImport(statement, links);
	else if (statement.type === 'ExportNamedDeclaration') collectExportNamed(statement, links);
	else if (statement.type === 'VariableDeclaration') collectDeclaredRefs(statement, links, false);
	else if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
		const specifier = (statement.source as AstNode).value as string;
		links.reexports.push({ specifier, imported: '*', exported: '*' });
	} else if (statement.type === 'ExportDefaultDeclaration') {
		const ref = refOf(statement.declaration);
		if (ref !== null) links.localExports.push({ ...ref, exported: 'default' });
	} else if (statement.type === 'TSImportEqualsDeclaration' && statement.importKind !== 'type') {
		const specifier = literalSpecifier((statement.moduleReference as AstNode).expression);
		const local = nameOf(statement.id);
		if (specifier !== null) links.imports.push({ specifier, imported: '*', local });
	}
}

/** The specifier an `import()` / `require()` node loads: a string, null when not literal, undefined when not a load. */
function loadedSpecifier(node: AstNode): string | null | undefined {
	if (node.type === 'ImportExpression') return literalSpecifier(node.source);
	if (node.type !== 'CallExpression') return undefined;
	const callee = node.callee as AstNode;
	const isLoad =
		callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require');
	return isLoad ? literalSpecifier((node.arguments as unknown[])[0]) : undefined;
}

const NOT_CODE_KEYS = new Set([
	'loc',
	'extra',
	'leadingComments',
	'trailingComments',
	'innerComments',
]);

/** Every `import()` / `require()` anywhere in the module, however deeply nested. */
function collectLoads(node: unknown, links: ModuleLinks): void {
	if (Array.isArray(node)) {
		for (const child of node) collectLoads(child, links);
		return;
	}
	if (node === null || typeof node !== 'object') return;
	const loaded = loadedSpecifier(node as AstNode);
	if (loaded === null) links.opaque = true;
	else if (loaded !== undefined)
		links.imports.push({ specifier: loaded, imported: '*', local: null });
	for (const [key, child] of Object.entries(node)) {
		if (!NOT_CODE_KEYS.has(key) && typeof child === 'object') collectLoads(child, links);
	}
}

/** A module's program. A parse failure THROWS: a module the census cannot read is not a clean one. */
function parseProgram(file: string, source: string): AstNode {
	try {
		const ast = parse(source, {
			sourceType: 'module',
			plugins: ['typescript', 'decorators-legacy'],
		});
		return ast.program as unknown as AstNode;
	} catch (error) {
		throw new Error(`door census: cannot parse ${file}: ${String(error)}`);
	}
}

function parseLinks(file: string, source: string): ModuleLinks {
	const links: ModuleLinks = {
		imports: [],
		reexports: [],
		localExports: [],
		aliases: new Map(),
		opaque: false,
	};
	const program = parseProgram(file, source);
	for (const statement of program.body as AstNode[]) collectStatement(statement, links);
	collectLoads(program.body, links);
	return links;
}

/** The repo file a relative specifier names, or null (packages, `bun:` — never a door). */
function resolveSpecifier(
	from: string,
	specifier: string,
	known: ReadonlyMap<string, string>,
): string | null {
	if (!specifier.startsWith('.')) return null;
	const base = normalizePosix(joinPosix(dirname(from), specifier));
	const candidates = [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`];
	return candidates.find((candidate) => known.has(candidate)) ?? null;
}

/** The doors a module hands out under `name` ('*' = all of them). */
function exposed(state: CensusState, from: string, specifier: string, name: string): Set<string> {
	const target = resolveSpecifier(from, specifier, state.sources);
	const exposure = target === null ? undefined : state.exposure.get(target);
	if (exposure === undefined) return new Set();
	if (name !== '*') return new Set(exposure.get(name) ?? []);
	return new Set([...exposure.values()].flatMap((doors) => [...doors]));
}

/** The doors a module-local name is bound to, following local `const` renames. */
function localReach(
	state: CensusState,
	file: string,
	links: ModuleLinks,
	ref: LocalRef,
): Set<string> {
	let current: LocalRef = ref;
	for (let step = 0; step < 8; step++) {
		const binding = links.imports.find((link) => link.local === current.local);
		if (binding !== undefined) {
			const key =
				binding.imported === '*'
					? (current.member ?? '*')
					: current.member === null
						? binding.imported
						: null;
			return key === null ? new Set() : exposed(state, file, binding.specifier, key);
		}
		const alias = links.aliases.get(current.local);
		if (alias === undefined || (alias.member !== null && current.member !== null)) return new Set();
		current = { local: alias.local, member: alias.member ?? current.member };
	}
	return new Set();
}

function addDoors(exposure: Exposure, name: string, doors: Set<string>): void {
	if (doors.size === 0) return;
	const held = exposure.get(name) ?? new Set<string>();
	for (const door of doors) held.add(door);
	exposure.set(name, held);
}

/** What a module hands out: its re-exports and its exported bindings that carry a door. */
function computeExposure(state: CensusState, file: string, links: ModuleLinks): Exposure {
	const exposure: Exposure = new Map();
	for (const link of links.reexports) {
		if (link.exported !== '*') {
			addDoors(exposure, link.exported, exposed(state, file, link.specifier, link.imported));
			continue;
		}
		const target = resolveSpecifier(file, link.specifier, state.sources);
		for (const [name, doors] of state.exposure.get(target ?? '') ?? []) {
			if (name !== 'default') addDoors(exposure, name, doors);
		}
	}
	for (const ref of links.localExports) {
		addDoors(exposure, ref.exported, localReach(state, file, links, ref));
	}
	return exposure;
}

/** A stable fingerprint, so the fixpoint knows when nothing changed. */
function exposureKey(exposure: Exposure | undefined): string {
	const entries = [...(exposure ?? new Map<string, Set<string>>())];
	return JSON.stringify(entries.map(([name, doors]) => [name, [...doors].sort()]).sort());
}

/** The name a specifier must spell to reach `file` (a directory for an index module). */
function specifierStem(file: string): string {
	const stem = basename(file).replace(/\.ts$/, '');
	return stem === 'index' ? basename(dirname(file)) : stem;
}

/** One fixpoint pass; true when some module's exposure grew. */
function exposurePass(state: CensusState): boolean {
	const stems = [...state.exposure.keys()].map(specifierStem);
	let grew = false;
	for (const [file, source] of state.sources) {
		// Only a module whose text spells a carrier's name can bind to it — which is
		// what keeps this from parsing the whole tree.
		if (file === GUARD || !stems.some((stem) => source.includes(stem))) continue;
		const links = state.links.get(file) ?? parseLinks(file, source);
		state.links.set(file, links);
		// A seeded door module hands out exactly its seed (its own imports still count).
		if (state.seeds[file] !== undefined) continue;
		const next = computeExposure(state, file, links);
		if (exposureKey(next) === exposureKey(state.exposure.get(file))) continue;
		if (next.size > 0) state.exposure.set(file, next);
		grew = true;
	}
	return grew;
}

/** Everything a module binds to: imports, re-exports, and the opaque marker. */
function reachOf(state: CensusState, file: string, links: ModuleLinks): Set<string> {
	const reach = new Set<string>();
	for (const link of [...links.imports, ...links.reexports]) {
		for (const door of exposed(state, file, link.specifier, link.imported)) reach.add(door);
	}
	if (links.opaque) reach.add(OPAQUE);
	return reach;
}

/**
 * file → the raw doors it can reach by BINDING (directly or through any chain
 * of re-exporting modules). Pure over its input, so a synthetic tree can prove
 * what the real one is checked for.
 */
function doorCensus(
	sources: ReadonlyMap<string, string>,
	seeds: Readonly<Record<string, readonly string[]>> = DOOR_SEEDS,
): Map<string, Set<string>> {
	const state: CensusState = { sources, seeds, links: new Map(), exposure: new Map() };
	for (const [file, doors] of Object.entries(seeds)) {
		if (sources.has(file)) state.exposure.set(file, new Map(doors.map((d) => [d, new Set([d])])));
	}
	// Exposure only grows and is bounded by modules × doors, so this terminates.
	while (exposurePass(state)) {
		/* until no carrier's exposure grows */
	}
	const census = new Map<string, Set<string>>();
	for (const [file, links] of state.links) {
		const reach = reachOf(state, file, links);
		if (reach.size > 0) census.set(file, reach);
	}
	return census;
}

function interactiveViolations(
	file: string,
	doors: Set<string>,
	importers: Readonly<Record<string, InteractiveRoute>>,
): string[] {
	if (!doors.has(INTERACTIVE_DOOR) || importers[file] !== undefined) return [];
	return [
		`${file}: holds ${INTERACTIVE_DOOR} — only the core route that relays a stored source may ` +
			'(it skips robots.txt and the default pace on purpose, and owes the permission check ' +
			`itself). Harvest through harvestFetch (${HARVEST_DOOR}).`,
	];
}

function toolViolations(file: string, doors: Set<string>): string[] {
	return [...doors]
		.filter((door) => door !== OPAQUE)
		.map(
			(door) =>
				`${file}: a tool holds ${door}. Harvest pages through harvestFetch (${HARVEST_DOOR}); ` +
				'one API call to a configured service belongs in engine code, not in a tool',
		);
}

function agentChannelViolations(file: string, doors: Set<string>): string[] {
	const found: string[] = [];
	if (doors.has('dialAgent')) {
		found.push(
			`${file}: holds dialAgent — the door's own seam takes TLS material from its caller; ` +
				`production dials through agentRequest (${AGENT_CHANNEL})`,
		);
	}
	if (doors.has('agentRequest') && AGENT_CHANNEL_IMPORTERS[file] === undefined) {
		found.push(
			`${file}: holds agentRequest — only the publication-host client may dial an agent: it ` +
				'proves the pairing before any bearer is sent (engineering/PUBLICATION_HOST_SPEC.md §2)',
		);
	}
	return found;
}

/** Every rule the census enforces, as messages; empty when the tree is clean. */
function doorViolations(
	census: Map<string, Set<string>>,
	interactiveImporters: Readonly<Record<string, InteractiveRoute>> = INTERACTIVE_IMPORTERS,
): string[] {
	const found: string[] = [];
	for (const [file, doors] of census) {
		if (doors.has(OPAQUE)) {
			found.push(
				`${file}: names a door module but loads a non-literal import() — the census cannot see what it reaches`,
			);
		}
		if (doors.has('fetchPinnedHop') && PINNED_HOP_IMPORTERS[file] === undefined) {
			found.push(
				`${file}: holds fetchPinnedHop — only the harvest redirect loop may (it owes every per-hop ` +
					`rule the primitive does not apply). Harvest through harvestFetch (${HARVEST_DOOR}).`,
			);
		}
		if (doors.has(FOLLOW_DOOR) && FOLLOW_VETTED_IMPORTERS[file] === undefined) {
			found.push(
				`${file}: holds ${FOLLOW_DOOR} — it follows redirects but owes robots.txt and pacing to ` +
					`its caller's beforeHop. Harvest through harvestFetch (${HARVEST_DOOR}).`,
			);
		}
		found.push(...agentChannelViolations(file, doors));
		found.push(...interactiveViolations(file, doors, interactiveImporters));
		if (file.startsWith('tools/')) found.push(...toolViolations(file, doors));
	}
	return found.sort();
}

// ---------------------------------------------------------------------------
// What the census cannot see by NAME: a module's runtime export surface, how many times it
// uses a door, and whether a route's row is backed by a gate. Each reader is driven on
// synthetic text below, so it is known to see what it claims to.
// ---------------------------------------------------------------------------

/** The runtime names an `export <declaration>` introduces: an interface and a type alias are erased. */
function declaredRuntimeNames(declaration: AstNode | null | undefined): string[] {
	if (declaration === null || declaration === undefined || declaration.declare === true) return [];
	switch (declaration.type) {
		case 'VariableDeclaration':
			return (declaration.declarations as AstNode[]).flatMap((entry) => patternNames(entry.id));
		case 'FunctionDeclaration':
		case 'ClassDeclaration':
		case 'TSEnumDeclaration':
		case 'TSModuleDeclaration':
			return [nameOf(declaration.id)];
		default:
			return [];
	}
}

/**
 * The names a module exports AT RUN TIME, sorted: declarations, specifiers (renames and
 * `export … from` included), `default`, `export * as ns`. A bare `export * from` hands out
 * names this reader cannot list, so it is reported as `*` — a surface nobody can pin.
 * Type-only exports are erased, so they are not in the list.
 */
function runtimeExportNames(file: string, source: string): string[] {
	const names = new Set<string>();
	for (const statement of parseProgram(file, source).body as AstNode[]) {
		if (statement.type === 'ExportDefaultDeclaration') names.add('default');
		else if (statement.type === 'TSExportAssignment') names.add('export=');
		else if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
			names.add('*');
		} else if (statement.type === 'ExportNamedDeclaration' && statement.exportKind !== 'type') {
			for (const binding of (statement.specifiers ?? []) as AstNode[]) {
				if (binding.exportKind !== 'type') names.add(nameOf(binding.exported));
			}
			for (const name of declaredRuntimeNames(
				statement.declaration as AstNode | null | undefined,
			)) {
				names.add(name);
			}
		}
	}
	return [...names].sort();
}

interface DoorUses {
	/** Every reference to the door's binding (a re-export, an alias, a namespace member). */
	references: number;
	/** The references that ARE the callee of a call. */
	calls: number;
}

/**
 * How `file` uses `door` of `from`: every reference to the binding — imported under any
 * name, through the module's namespace, or re-exported — and which of them are a direct
 * call. Over-inclusive on purpose (a shadowing parameter counts): a module that is legal
 * has exactly the uses it is meant to have, so anything else is for a human to read.
 */
function doorUses(file: string, source: string, from: string, door: string): DoorUses {
	const program = parseProgram(file, source);
	const known = new Map([[from, '']]);
	const reaches = (statement: AstNode): boolean =>
		resolveSpecifier(file, (statement.source as AstNode).value as string, known) === from;
	const direct = new Set<string>();
	const spaces = new Set<string>();
	const uses: DoorUses = { references: 0, calls: 0 };
	for (const statement of program.body as AstNode[]) {
		if (statement.type === 'ImportDeclaration' && statement.importKind !== 'type') {
			if (!reaches(statement)) continue;
			for (const binding of statement.specifiers as AstNode[]) {
				if (binding.importKind === 'type') continue;
				if (binding.type === 'ImportNamespaceSpecifier') spaces.add(nameOf(binding.local));
				else if (binding.type === 'ImportSpecifier' && nameOf(binding.imported) === door) {
					direct.add(nameOf(binding.local));
				}
			}
		} else if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
			if (reaches(statement)) uses.references++;
		} else if (
			statement.type === 'ExportNamedDeclaration' &&
			statement.exportKind !== 'type' &&
			statement.source !== null &&
			statement.source !== undefined &&
			reaches(statement)
		) {
			for (const binding of statement.specifiers as AstNode[]) {
				const named = binding.type === 'ExportNamespaceSpecifier' || nameOf(binding.local) === door;
				if (binding.exportKind !== 'type' && named) uses.references++;
			}
		}
	}
	const body = (program.body as AstNode[]).filter(
		(statement) =>
			statement.type !== 'ImportDeclaration' && !('source' in statement && statement.source),
	);
	walkAst(body, [], (node, ancestors) => {
		if (node.type !== 'Identifier') return;
		const parent = ancestors[ancestors.length - 1];
		if (isNameOnly(node, parent)) return;
		if (direct.has(node.name as string)) {
			uses.references++;
			if (parent?.type === 'CallExpression' && parent.callee === node) uses.calls++;
		} else if (spaces.has(node.name as string)) {
			uses.references++;
			const reachesDoor =
				parent?.type === 'MemberExpression' &&
				parent.object === node &&
				readsProperty(parent, door);
			const outer = ancestors[ancestors.length - 2];
			if (reachesDoor && outer?.type === 'CallExpression' && outer.callee === parent) uses.calls++;
		}
	});
	return uses;
}

/** What is wrong with one route row, as messages. `sources` holds the route's and its gate's text. */
function routeRowProblems(
	file: string,
	row: InteractiveRoute,
	sources: ReadonlyMap<string, string>,
): string[] {
	const problems: string[] = [];
	const say = (what: string) => problems.push(`${file}: ${what}`);
	if (!file.startsWith('src/core/')) say('the relay is a CORE module, never a tool');
	if (row.reason.trim().length < MIN_ROUTE_REASON_LENGTH) {
		say(`reason is shorter than ${MIN_ROUTE_REASON_LENGTH} characters — say what the route does`);
	}
	const handlers = [...row.handlers];
	if (
		handlers.length === 0 ||
		new Set(handlers).size !== handlers.length ||
		handlers.includes('')
	) {
		say('handlers must be a non-empty list of distinct export names');
	}
	const routeSource = sources.get(file);
	if (routeSource === undefined) say('the route module could not be read');
	else {
		const exports = runtimeExportNames(file, routeSource);
		if (exports.join() !== [...handlers].sort().join()) {
			say(
				`runtime exports [${exports.join(', ')}] are not exactly the handlers [${[...handlers].sort().join(', ')}] — ` +
					'a route exports route handlers and nothing a caller could hand a URL to',
			);
		}
	}
	problems.push(...routeGateProblems(file, row, handlers, sources));
	return problems;
}

/** What is wrong with a route's gate: its shape, that it exists, and that it is about THIS route. */
function routeGateProblems(
	file: string,
	row: InteractiveRoute,
	handlers: readonly string[],
	sources: ReadonlyMap<string, string>,
): string[] {
	const say = (what: string) => [`${file}: gate ${row.gate} ${what}`];
	if (!ROUTE_GATE_PATH.test(row.gate)) return say('is not test/unit/<route>_native.test.ts');
	if (HARVEST_DOOR_GATES.has(row.gate))
		return say('is one of the door’s own gates, not the route’s');
	const gateSource = sources.get(row.gate);
	if (gateSource === undefined) return say('does not exist');
	const problems: string[] = [];
	const code = stripComments(gateSource);
	const importsRoute = parseLinks(row.gate, gateSource).imports.some(
		(link) => resolveSpecifier(row.gate, link.specifier, new Map([[file, '']])) === file,
	);
	if (!importsRoute) problems.push(...say('does not import the route module'));
	for (const handler of handlers) {
		if (!new RegExp(`(?<![\\w$])${handler}(?![\\w$])`).test(code)) {
			problems.push(...say(`never names the handler ${handler}`));
		}
	}
	const tests = (code.match(/(?<![\w$.])(?:test|it)(?:\.\w+)?\s*\(/g) ?? []).length;
	if (tests < MIN_ROUTE_GATE_TESTS) {
		problems.push(
			...say(`has ${tests} tests; a route's contract needs at least ${MIN_ROUTE_GATE_TESTS}`),
		);
	}
	if (!/(?<![\w$.])expect\s*\(/.test(code)) problems.push(...say('asserts nothing'));
	return problems;
}

/** Every problem with the table of routes that may hold the interactive door; empty when sound. */
function interactiveRouteProblems(
	rows: Readonly<Record<string, InteractiveRoute>>,
	sources: ReadonlyMap<string, string>,
): string[] {
	const files = Object.keys(rows);
	const problems: string[] = [];
	if (files.length > MAX_INTERACTIVE_ROUTES) {
		problems.push(
			`${files.length} routes hold ${INTERACTIVE_DOOR} (${files.join(', ')}): the spec allows ONE ` +
				'(engineering/OUTBOUND_SPEC.md §3.1) — a second relay is a change to the spec first',
		);
	}
	for (const file of files)
		problems.push(...routeRowProblems(file, rows[file] as InteractiveRoute, sources));
	return problems;
}

describe('who holds which door (import-graph census)', () => {
	const scanned = sourceFiles();
	const census = doorCensus(new Map(scanned.map((entry) => [entry.file, entry.code])));

	test('the census finds the holders it is supposed to (anti-vacuity)', () => {
		// A census that resolved nothing would pass every rule below.
		expect([...(census.get('src/core/harvest/follow.ts') ?? [])]).toEqual(['fetchPinnedHop']);
		for (const file of Object.keys(FOLLOW_VETTED_IMPORTERS)) {
			expect([...(census.get(file) ?? [])], file).toEqual([FOLLOW_DOOR]);
		}
		expect(census.get('src/core/tools/translation.ts')?.has('fetchGuardedText')).toBe(true);
		expect(census.get('src/core/tools/transcription_local_asr.ts')?.has('fetchBoundedText')).toBe(
			true,
		);
		// The harvesting tool holds the door it should, and through it no raw one.
		const rdf = 'tools/tool_import_rdf/server/index.ts';
		const withHarvest = doorCensus(
			new Map(scanned.map((entry) => [entry.file, entry.code])),
			OUTBOUND_DOOR_SEEDS,
		);
		expect([...(withHarvest.get(rdf) ?? [])]).toEqual(['harvestFetch']);
		expect(census.has(rdf)).toBe(false);
		// The interactive door's seed names a function the module really exports — a seed
		// for a name that no longer exists would census nothing and pass every rule below —
		// and the harvesting tools hold the default door only, not this one.
		const harvestCode = scanned.find((entry) => entry.file === HARVEST_DOOR)?.code ?? '';
		expect(harvestCode).toMatch(new RegExp(`export async function ${INTERACTIVE_DOOR}\\b`));
		for (const tool of [
			rdf,
			'tools/tool_numisdata_acquisition/server/index.ts',
			'tools/tool_bibliography_acquisition/server/index.ts',
		]) {
			expect([...(withHarvest.get(tool) ?? [])], tool).toEqual(['harvestFetch']);
		}
	});

	test('the pinned hop has one holder, and no tool holds a raw door', () => {
		const violations = doorViolations(census);
		expect(
			violations,
			`engineering/OUTBOUND_SPEC.md names the doors.\n  ${violations.join('\n  ')}`,
		).toEqual([]);
	});

	test('the exemptions may only SHRINK', () => {
		const stale: string[] = [];
		for (const file of Object.keys(PINNED_HOP_IMPORTERS)) {
			if (census.get(file)?.has('fetchPinnedHop') !== true)
				stale.push(`${file}: no longer holds fetchPinnedHop`);
		}
		for (const file of Object.keys(FOLLOW_VETTED_IMPORTERS)) {
			if (census.get(file)?.has(FOLLOW_DOOR) !== true)
				stale.push(`${file}: no longer holds ${FOLLOW_DOOR}`);
		}
		for (const file of Object.keys(AGENT_CHANNEL_IMPORTERS)) {
			if (census.get(file)?.has('agentRequest') !== true)
				stale.push(`${file}: no longer holds agentRequest`);
		}
		for (const file of Object.keys(INTERACTIVE_IMPORTERS)) {
			if (census.get(file)?.has(INTERACTIVE_DOOR) !== true)
				stale.push(`${file}: no longer holds ${INTERACTIVE_DOOR}`);
		}
		expect(stale, 'a row for a debt already paid hides that it was paid').toEqual([]);
	});

	test('the agent channel is censused like the other doors (synthetic tree)', () => {
		// Every holder shape must be seen — direct, through a barrel, renamed, by namespace,
		// from a tool — and the seam refused everywhere. The client's row (when it exists)
		// is the only legal holder of agentRequest.
		const client = 'src/core/publication_host/agent_client.ts';
		const synthetic = new Map<string, string>([
			[
				AGENT_CHANNEL,
				'export async function agentRequest() {}\nexport async function dialAgent() {}',
			],
			[client, "import { agentRequest } from './transport.ts';\nexport const x = agentRequest;"],
			['src/core/publication_host/barrel.ts', "export * from './transport.ts';"],
			[
				'src/core/area_maintenance/widgets/publication_hosts.ts',
				"import { agentRequest as dial } from '../../publication_host/barrel.ts';\nvoid dial;",
			],
			[
				'src/core/publication_host/seam_user.ts',
				"import { dialAgent } from './transport.ts';\nvoid dialAgent;",
			],
			[
				'tools/tool_pub/server/index.ts',
				"import * as t from '../../../src/core/publication_host/transport.ts';\nvoid t;",
			],
		]);
		const census = doorCensus(synthetic);
		expect([
			...(census.get('src/core/area_maintenance/widgets/publication_hosts.ts') ?? []),
		]).toEqual(['agentRequest']);
		expect([...(census.get('tools/tool_pub/server/index.ts') ?? [])].sort()).toEqual([
			...AGENT_CHANNEL_DOORS,
		]);
		const violations = doorViolations(census);
		const flagged = (file: string, door: string) =>
			violations.some((v) => v.startsWith(`${file}: holds ${door}`));
		expect(flagged('src/core/area_maintenance/widgets/publication_hosts.ts', 'agentRequest')).toBe(
			true,
		);
		expect(flagged('src/core/publication_host/seam_user.ts', 'dialAgent')).toBe(true);
		expect(flagged('tools/tool_pub/server/index.ts', 'dialAgent')).toBe(true);
		expect(flagged(client, 'agentRequest')).toBe(AGENT_CHANNEL_IMPORTERS[client] === undefined);
	});

	test('the interactive profile is censused like the other doors (synthetic tree)', () => {
		// A tool must never reach it — directly, through a barrel, renamed, by namespace —
		// and a core module only by a reasoned row. The legal shapes must NOT be flagged:
		// the default door in a tool, and the one row'd route.
		const up = '../../../src/core';
		const route = 'src/core/map_route/relay.ts';
		const synthetic = new Map<string, string>([
			[
				HARVEST_DOOR,
				'export async function harvestFetch() {}\nexport async function interactiveFetch() {}',
			],
			[
				route,
				"import { interactiveFetch } from '../harvest/harvest.ts';\nexport const handle = () => interactiveFetch;",
			],
			[
				'src/core/other/barrel.ts',
				"export { interactiveFetch as relay } from '../harvest/harvest.ts';",
			],
			[
				'src/core/other/second_route.ts',
				"import { relay } from './barrel.ts';\nexport const again = () => relay;",
			],
			[
				'tools/tool_direct/server/index.ts',
				`import { interactiveFetch } from '${up}/harvest/harvest.ts';\nvoid interactiveFetch;`,
			],
			[
				'tools/tool_barrel/server/index.ts',
				`import { relay as r } from '${up}/other/barrel.ts';\nvoid r;`,
			],
			[
				'tools/tool_namespace/server/index.ts',
				`import * as door from '${up}/harvest/harvest.ts';\nvoid door.interactiveFetch;`,
			],
			[
				'tools/tool_default_only/server/index.ts',
				`import { harvestFetch } from '${up}/harvest/harvest.ts';\nvoid harvestFetch;`,
			],
		]);
		const synth = doorCensus(synthetic);
		const doorsOf = (file: string): string[] => [...(synth.get(file) ?? [])].sort();
		expect(doorsOf(route)).toEqual([INTERACTIVE_DOOR]);
		expect(doorsOf('src/core/other/second_route.ts')).toEqual([INTERACTIVE_DOOR]);
		expect(doorsOf('tools/tool_direct/server/index.ts')).toEqual([INTERACTIVE_DOOR]);
		expect(doorsOf('tools/tool_barrel/server/index.ts')).toEqual([INTERACTIVE_DOOR]);
		expect(doorsOf('tools/tool_namespace/server/index.ts')).toEqual([INTERACTIVE_DOOR]);
		// The default door is not a door of this census, so a harvesting tool stays clean.
		expect(doorsOf('tools/tool_default_only/server/index.ts')).toEqual([]);

		const row = (module: string): InteractiveRoute => ({
			reason: `the one relay (${module}): a synthetic row, long enough to say something`,
			gate: 'test/unit/map_route_native.test.ts',
			handlers: ['handle'],
		});
		const holders = (importers: Record<string, InteractiveRoute>) =>
			[...new Set(doorViolations(synth, importers).map((line) => line.split(':')[0]))].sort();
		// (A barrel re-exporting the door holds it, like the follow-loop's barrel above.)
		const everyone = [
			route,
			'src/core/other/barrel.ts',
			'src/core/other/second_route.ts',
			'tools/tool_barrel/server/index.ts',
			'tools/tool_direct/server/index.ts',
			'tools/tool_namespace/server/index.ts',
		].sort();
		// No row: every holder is refused, the route included.
		expect(holders({})).toEqual(everyone);
		// The route's row excuses the route and ONLY the route — never a tool, never a second module.
		expect(holders({ [route]: row(route) })).toEqual(everyone.filter((file) => file !== route));
		// A tool is refused even WITH a row: the row table is for core modules.
		const tool = 'tools/tool_direct/server/index.ts';
		expect(
			doorViolations(synth, { [tool]: row(tool) }).some((v) =>
				v.startsWith(`${tool}: a tool holds`),
			),
		).toBe(true);
	});

	test('the census sees through every binding form (synthetic tree)', () => {
		// The rules above are only as good as the census, and a clean real tree
		// cannot show that it would catch anything. So a synthetic tree carries one
		// module per evasion, and each must be caught — or, for the legitimate
		// shapes, must NOT be.
		const up = '../../../src/core';
		const synthetic = new Map<string, string>([
			[
				GUARD,
				'export async function fetchPinnedHop() {}\nexport async function fetchBoundedText() {}\n' +
					'export async function fetchGuardedText() {}\nexport function isPrivateIp() {}',
			],
			// The legitimate shapes.
			[
				'src/core/harvest/follow.ts',
				"import { fetchPinnedHop as hop } from '../security/ssrf_guard.ts';\nexport const followVetted = () => hop;",
			],
			[
				'src/core/harvest/robots.ts',
				"import { followVetted } from './follow.ts';\nexport const load = () => followVetted();",
			],
			// A tool on the redirect loop with a no-op beforeHop: no robots, no pace.
			[
				'tools/tool_follow/server/index.ts',
				`import { followVetted } from '${up}/harvest/follow.ts';\n` +
					'export const go = () => followVetted({}, { beforeHop: async () => undefined });',
			],
			['src/core/x/follow_barrel.ts', "export * from '../harvest/follow.ts';"],
			[
				'tools/tool_follow_barrel/server/index.ts',
				`import { followVetted as f } from '${up}/x/follow_barrel.ts';`,
			],
			[
				'src/core/harvest/harvest.ts',
				"import { followVetted } from './follow.ts';\nexport const harvestFetch = () => followVetted();",
			],
			[
				'tools/tool_clean/server/index.ts',
				`import { harvestFetch } from '${up}/harvest/harvest.ts';\n` +
					`import type { fetchPinnedHop as HopType, PinnedHopRequest } from '${up}/security/ssrf_guard.ts';\n` +
					`import { isPrivateIp, type fetchPinnedHop } from '${up}/security/ssrf_guard.ts';`,
			],
			// A tool importing a raw door directly: no row can excuse it any more —
			// neither an arbitrary tool nor the one the last row used to exempt.
			[
				'tools/tool_raw/server/index.ts',
				`import { fetchGuardedText } from '${up}/security/ssrf_guard.ts';`,
			],
			[
				'tools/tool_import_rdf/server/index.ts',
				`import { fetchGuardedText } from '${up}/security/ssrf_guard.ts';`,
			],
			// The evasions: re-export chains, namespace members, renames, loads.
			[
				'src/core/x/barrel.ts',
				"export { fetchGuardedText as get } from '../security/ssrf_guard.ts';",
			],
			['src/core/x/star.ts', "export * from './barrel.ts';"],
			[
				'src/core/y/alias.ts',
				"import * as guard from '../security/ssrf_guard.ts';\nconst hop = guard['fetchPinnedHop'];\nexport { hop as pull };",
			],
			[
				'src/core/z/second_hop.ts',
				"import { fetchPinnedHop } from '../security/ssrf_guard';\nexport default fetchPinnedHop;",
			],
			[
				'src/core/y/computed.ts',
				"import * as guard from '../security/ssrf_guard.ts';\nconst key = pick();\nexport const any = guard[key];",
			],
			['tools/tool_barrel/server/index.ts', `import { get } from '${up}/x/star.ts';`],
			['tools/tool_computed/server/index.ts', `import { any } from '${up}/y/computed.ts';`],
			['tools/tool_alias/server/index.ts', `import { pull as p } from '${up}/y/alias.ts';`],
			['tools/tool_default/server/index.ts', `import anything from '${up}/z/second_hop.ts';`],
			[
				'tools/tool_dynamic/server/index.ts',
				`export async function go() { return (await import('${up}/security/ssrf_guard.ts')).fetchBoundedText; }`,
			],
			['tools/tool_require/server/index.ts', `import m = require('${up}/security/ssrf_guard.ts');`],
			[
				'tools/tool_opaque/server/index.ts',
				`const which = 'ssrf_guard';\nexport const go = () => import(\`${up}/security/\${which}.ts\`);`,
			],
		]);
		const synth = doorCensus(synthetic);
		const doorsOf = (file: string): string[] => [...(synth.get(file) ?? [])].sort();
		expect(doorsOf('tools/tool_clean/server/index.ts')).toEqual([]);
		expect(doorsOf('tools/tool_barrel/server/index.ts')).toEqual(['fetchGuardedText']);
		expect(doorsOf('tools/tool_alias/server/index.ts')).toEqual(['fetchPinnedHop']);
		expect(doorsOf('tools/tool_default/server/index.ts')).toEqual(['fetchPinnedHop']);
		// A key the scanner cannot read is every key.
		expect(doorsOf('tools/tool_computed/server/index.ts')).toEqual([...RAW_DOORS].sort());
		expect(doorsOf('tools/tool_dynamic/server/index.ts')).toEqual([...RAW_DOORS].sort());
		expect(doorsOf('tools/tool_require/server/index.ts')).toEqual([...RAW_DOORS].sort());
		expect(doorsOf('tools/tool_opaque/server/index.ts')).toEqual([OPAQUE]);
		expect(doorsOf('tools/tool_follow/server/index.ts')).toEqual([FOLLOW_DOOR]);
		expect(doorsOf('tools/tool_follow_barrel/server/index.ts')).toEqual([FOLLOW_DOOR]);
		expect(doorsOf('src/core/harvest/harvest.ts')).toEqual([FOLLOW_DOOR]);
		expect(doorsOf('src/core/harvest/follow.ts')).toEqual(['fetchPinnedHop']);

		const violators = [...new Set(doorViolations(synth).map((line) => line.split(':')[0]))].sort();
		expect(violators).toEqual(
			[
				'src/core/x/follow_barrel.ts',
				'src/core/y/alias.ts',
				'src/core/y/computed.ts',
				'src/core/z/second_hop.ts',
				'tools/tool_alias/server/index.ts',
				'tools/tool_follow/server/index.ts',
				'tools/tool_follow_barrel/server/index.ts',
				'tools/tool_barrel/server/index.ts',
				'tools/tool_computed/server/index.ts',
				'tools/tool_default/server/index.ts',
				'tools/tool_dynamic/server/index.ts',
				'tools/tool_import_rdf/server/index.ts',
				'tools/tool_opaque/server/index.ts',
				'tools/tool_raw/server/index.ts',
				'tools/tool_require/server/index.ts',
			].sort(),
		);
	});
});

// ---------------------------------------------------------------------------
// WHAT A DOOR'S HOLDER SAYS, AND WHO READS THE GUARD'S REASONS.
//
// The guard's own `Error.message` names the address it refused (`… resolves to a
// private/reserved address (::1)`): right for the log, an internal-network oracle
// on the wire. So a TOOL that holds any outbound door — a raw one or
// `harvestFetch` — reports a failure as `toErrorBody(toDedaloError(error))` and
// reads no error's `.message` at all (docs/development/tools/security.md item 7).
// And the address-vs-shape split of the guard's refusals is ONE table
// (`SSRF_REFUSAL_KINDS`) read through ONE predicate (`isAddressRefusal`): a module
// spelling an address reason itself is a private copy of that table, which drifts
// the day the guard learns a new reason.
// ---------------------------------------------------------------------------

/**
 * `harvest.ts`'s RUNTIME export surface, exactly. `interactiveFetch`'s profile and the
 * pipeline both profiles run (`harvestWith`) are module-private BY DESIGN: a profile is
 * chosen by which function a caller imported, never by a value it can pass. The door census
 * above sees a holder of a NAMED door (`harvestFetch`, `interactiveFetch`), so exporting the
 * pipeline or a profile builder would hand a tool the choice and pass every census. Adding
 * an export here is therefore a decision: this list is the review.
 */
const HARVEST_DOOR_EXPORTS: readonly string[] = [
	// The two doors.
	'harvestFetch',
	'interactiveFetch',
	// Read by tools and the engine around the door.
	'decodeBody',
	'retryAfterMs',
	'HARVEST_USER_AGENT',
	// The default profile's documented limits (a tool may read them to size a request).
	'HARVEST_DEFAULT_IDLE_TIMEOUT_MS',
	'HARVEST_DEFAULT_MAX_BYTES',
	'HARVEST_DEFAULT_TIMEOUT_MS',
	'HARVEST_MAX_BYTES',
	'HARVEST_MAX_TIMEOUT_MS',
];

describe('the harvesting door keeps its profiles private (outcome, not census)', () => {
	const harvestSource = readFileSync(join(REPO_ROOT, HARVEST_DOOR), 'utf8');

	test('harvest.ts exports exactly the listed names: no profile, no pipeline, no builder', () => {
		const expected = [...HARVEST_DOOR_EXPORTS].sort();
		expect(runtimeExportNames(HARVEST_DOOR, harvestSource)).toEqual(expected);
		// And the reader agrees with the module as it really loads — a reader that saw nothing
		// would pass an empty list, and a list the module does not match would pass a stale reader.
		expect(Object.keys(harvestModule).sort()).toEqual(expected);
	});

	test('the pipeline of both profiles is entered at exactly ONE place per module', () => {
		// harvest.ts calls the redirect loop once (`harvestWith`, which both profiles run) and
		// robots.ts once (the robots.txt fetch). A second call site in harvest.ts is a second
		// pipeline with a `beforeHop` of its own — the way a profile could be chosen by a value.
		for (const file of Object.keys(FOLLOW_VETTED_IMPORTERS)) {
			const source = readFileSync(join(REPO_ROOT, file), 'utf8');
			expect(doorUses(file, source, FOLLOW, FOLLOW_DOOR), file).toEqual({
				references: 1,
				calls: 1,
			});
		}
		// Anti-vacuity: the loop is really bound under that name in each.
		expect(harvestSource).toContain('followVetted(');
	});

	test('the readers see what they claim (synthetic text)', () => {
		const names = (code: string) => runtimeExportNames('src/x.ts', code);
		expect(
			names(
				[
					'export const a = 1, { b, c: [d] } = o;',
					'export function f() {}',
					'export class K {}',
					'export enum E { X }',
					'export { g as h } from "./g.ts";',
					'export * as ns from "./n.ts";',
					'export default function () {}',
					'export type T = string;',
					'export interface I {}',
					'export declare const ambient: number;',
					'export type { Z } from "./z.ts";',
					'const local = 1; export { local as renamed };',
				].join('\n'),
			),
		).toEqual(['E', 'K', 'a', 'b', 'd', 'default', 'f', 'h', 'ns', 'renamed']);
		// A star export hands out names nobody can list: reported, so it can be refused.
		expect(names('export * from "./all.ts";')).toEqual(['*']);

		const uses = (code: string) => doorUses('src/core/harvest/m.ts', code, FOLLOW, FOLLOW_DOOR);
		const imp = "import { followVetted } from './follow.ts';\n";
		expect(uses(`${imp}await followVetted(plan, options);`)).toEqual({ references: 1, calls: 1 });
		// A second call with another gate, an alias, a namespace member, a re-export, a value
		// handed on, a rename: each is seen, and none is a clean single call.
		expect(uses(`${imp}followVetted(a); followVetted(b);`)).toEqual({ references: 2, calls: 2 });
		expect(uses(`${imp}const f = followVetted; f(a); f(b);`)).toEqual({ references: 1, calls: 0 });
		expect(uses(`${imp}run(followVetted);`)).toEqual({ references: 1, calls: 0 });
		expect(uses(`${imp}export const door = { followVetted };`)).toEqual({
			references: 1,
			calls: 0,
		});
		expect(uses("import { followVetted as go } from './follow.ts';\ngo(a); go(b);")).toEqual({
			references: 2,
			calls: 2,
		});
		expect(
			uses("import * as loop from './follow.ts';\nloop.followVetted(a); loop['followVetted'](b);"),
		).toEqual({ references: 2, calls: 2 });
		expect(uses("import * as loop from './follow.ts';\nrun(loop);")).toEqual({
			references: 1,
			calls: 0,
		});
		expect(uses("export { followVetted } from './follow.ts';")).toEqual({
			references: 1,
			calls: 0,
		});
		expect(uses("export * from './follow.ts';")).toEqual({ references: 1, calls: 0 });
		// Not the door: a property of that name, another module's binding, a type-only import.
		expect(uses(`${imp}const x = { followVetted: 1 }; o.followVetted;`)).toEqual({
			references: 0,
			calls: 0,
		});
		expect(uses("import { followVetted } from './elsewhere.ts';\nfollowVetted(a);")).toEqual({
			references: 0,
			calls: 0,
		});
		expect(
			uses("import type { followVetted } from './follow.ts';\ntype T = typeof followVetted;"),
		).toEqual({ references: 0, calls: 0 });
	});
});

describe('the interactive door’s route row is backed by a gate (synthetic rows; the real row is checked above)', () => {
	const route = 'src/core/map_route/relay.ts';
	const gate = 'test/unit/map_route_native.test.ts';
	const goodRoute =
		'export async function handleTile() {}\nexport async function handleLegend() {}\n';
	const goodGate = (tests = MIN_ROUTE_GATE_TESTS): string =>
		[
			"import { handleLegend, handleTile } from '../../src/core/map_route/relay.ts';",
			...Array.from(
				{ length: tests },
				(_, i) =>
					`test('clause ${i}', () => { expect(handleTile).toBeDefined(); void handleLegend; });`,
			),
		].join('\n');
	const row: InteractiveRoute = {
		reason:
			'resolves a stored source, checks the permission first, maps every failure to one refusal',
		gate,
		handlers: ['handleTile', 'handleLegend'],
	};
	const sources = (over: Record<string, string | null> = {}): Map<string, string> => {
		const all: Record<string, string | null> = { [route]: goodRoute, [gate]: goodGate(), ...over };
		return new Map(
			Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null),
		);
	};
	const problems = (
		rows: Record<string, InteractiveRoute>,
		over: Record<string, string | null> = {},
	): string[] => interactiveRouteProblems(rows, sources(over));

	test('the real table is sound, and is the one tile route', () => {
		const files = new Map<string, string>();
		for (const [file, entry] of Object.entries(INTERACTIVE_IMPORTERS)) {
			for (const needed of [file, entry.gate]) {
				try {
					files.set(needed, readFileSync(join(REPO_ROOT, needed), 'utf8'));
				} catch {
					/* absent: reported by the checker as a missing module or gate */
				}
			}
		}
		expect(interactiveRouteProblems(INTERACTIVE_IMPORTERS, files)).toEqual([]);
		expect(Object.keys(INTERACTIVE_IMPORTERS).length).toBeLessThanOrEqual(MAX_INTERACTIVE_ROUTES);
		// Anti-vacuity: the table is not empty again by accident — the tile proxy is the row, and
		// its module (read above) and gate (exists, imports it) were really checked.
		expect(Object.keys(INTERACTIVE_IMPORTERS)).toEqual(['src/core/api/map_tile.ts']);
		expect([...files.keys()].sort()).toEqual([
			'src/core/api/map_tile.ts',
			'test/unit/map_tile_proxy_native.test.ts',
		]);
	});

	test('a sound row passes', () => {
		expect(problems({ [route]: row })).toEqual([]);
	});

	test('a row that only had to exist is refused: empty reason, no gate, a gate that is not about the route', () => {
		const flagged = (
			rows: Record<string, InteractiveRoute>,
			over?: Record<string, string | null>,
		) => problems(rows, over).length > 0;
		expect(flagged({ [route]: { ...row, reason: '' } })).toBe(true);
		expect(flagged({ [route]: { ...row, reason: 'ok' } })).toBe(true);
		expect(flagged({ [route]: { ...row, gate: '' } })).toBe(true);
		expect(flagged({ [route]: { ...row, gate: 'test/unit/anything.test.ts' } })).toBe(true);
		expect(flagged({ [route]: { ...row, gate: 'test/unit/harvest_door_native.test.ts' } })).toBe(
			true,
		);
		expect(flagged({ [route]: row }, { [gate]: null })).toBe(true); // the gate file does not exist
		expect(flagged({ [route]: row }, { [route]: null })).toBe(true); // nor the route
		expect(
			flagged(
				{ 'tools/tool_x/server/index.ts': row },
				{ 'tools/tool_x/server/index.ts': goodRoute },
			),
		).toBe(true);
		// A gate of the right name that is about something else, or says too little.
		expect(
			flagged({ [route]: row }, { [gate]: goodGate().replace('map_route/relay', 'other/thing') }),
		).toBe(true);
		expect(flagged({ [route]: row }, { [gate]: goodGate(MIN_ROUTE_GATE_TESTS - 1) })).toBe(true);
		expect(flagged({ [route]: row }, { [gate]: goodGate().replace(/expect\(/g, 'check(') })).toBe(
			true,
		);
		expect(flagged({ [route]: row }, { [gate]: goodGate().replace(/handleLegend/g, 'x') })).toBe(
			true,
		);
		expect(flagged({ [route]: { ...row, handlers: [] } })).toBe(true);
		expect(flagged({ [route]: { ...row, handlers: ['handleTile', 'handleTile'] } })).toBe(true);
	});

	test('the route exports its handlers and nothing a caller could hand a URL to', () => {
		const extra = `${goodRoute}export async function fetchTile(url: string) {}\n`;
		expect(problems({ [route]: row }, { [route]: extra }).join('\n')).toContain('fetchTile');
		expect(
			problems({ [route]: row }, { [route]: `${goodRoute}export * from './helpers.ts';\n` }),
		).not.toEqual([]);
		expect(
			problems({ [route]: row }, { [route]: `${goodRoute}export const LIMIT = 1;\n` }),
		).not.toEqual([]);
		// A declared handler the module does not export is as wrong as an undeclared export.
		expect(
			problems({ [route]: row }, { [route]: 'export async function handleTile() {}\n' }),
		).not.toEqual([]);
		// Types are erased: they widen nothing.
		expect(
			problems({ [route]: row }, { [route]: `${goodRoute}export type Tile = string;\n` }),
		).toEqual([]);
	});

	test('ONE route: a second row is refused', () => {
		const other = 'src/core/other_route/relay.ts';
		const rows = { [route]: row, [other]: { ...row } };
		expect(problems(rows, { [other]: goodRoute }).join('\n')).toContain('ONE');
	});
});

/** Every door a tool may hold, the harvesting door included. */
const OUTBOUND_DOOR_SEEDS: Record<string, readonly string[]> = {
	...DOOR_SEEDS,
	// Spread order matters: this key REPLACES `DOOR_SEEDS`'s, so `interactiveFetch` is
	// named here too or the disclosure census below would stop seeing its holders.
	[HARVEST_DOOR]: ['harvestFetch', INTERACTIVE_DOOR],
};

/**
 * `.message` read off a value. Read in code with LITERALS KEPT: a template literal's
 * `${(error as Error).message}` is the commonest read, and blanking literals blanks
 * it too (measured: the census went green over tool_import_rdf that way).
 */
const MESSAGE_READ = /\.message\b/;

/** Tools that hold an outbound door (by binding) and read an error's `.message`. */
function messageDisclosures(code: ReadonlyMap<string, string>): string[] {
	const holders = doorCensus(code, OUTBOUND_DOOR_SEEDS);
	return [...holders.keys()]
		.filter((file) => file.startsWith('tools/') && MESSAGE_READ.test(code.get(file) ?? ''))
		.sort();
}

/** The guard's ADDRESS reasons, from its own table. */
const ADDRESS_REASONS = Object.entries(SSRF_REFUSAL_KINDS)
	.filter(([, kind]) => kind === 'address')
	.map(([reason]) => reason);

/** Modules other than the guard that spell an address reason as a string literal. */
function reasonCopies(files: readonly { file: string; code: string }[]): string[] {
	const spelled = new RegExp(`(['"\`])(?:${ADDRESS_REASONS.join('|')})\\1`);
	return files
		.filter((entry) => entry.file !== GUARD && spelled.test(entry.code))
		.map((entry) => entry.file)
		.sort();
}

describe('a door holder discloses no address, and reads no reason of its own', () => {
	const scanned = sourceFiles();
	const code = new Map(scanned.map((entry) => [entry.file, entry.code]));

	test('a tool holding an outbound door never reads an error’s .message', () => {
		const found = messageDisclosures(code);
		expect(
			found,
			'report a failure as toErrorBody(toDedaloError(error)) — the guard’s message names ' +
				`the refused address:\n  ${found.join('\n  ')}`,
		).toEqual([]);
	});

	test('the disclosure census sees a door holder and a harvester (synthetic tree)', () => {
		const up = '../../../src/core';
		const synthetic = new Map<string, string>([
			[GUARD, 'export async function fetchGuardedText() {}'],
			[
				HARVEST_DOOR,
				'export async function harvestFetch() {}\nexport async function interactiveFetch() {}',
			],
			[
				'tools/tool_a/server/index.ts',
				`import { fetchGuardedText } from '${up}/security/ssrf_guard.ts';\ntry { await fetchGuardedText(u) } catch (e) { out.push((e as Error).message) }`,
			],
			[
				'tools/tool_b/server/index.ts',
				[
					`import { harvestFetch as h } from '${up}/harvest/harvest.ts';`,
					// The read inside a template literal — the shape tool_import_rdf had.
					'try { await h(u) } catch (err) { out.push(`${u}: ${err.message}`) }',
				].join('\n'),
			],
			[
				'tools/tool_c/server/index.ts',
				`import { toErrorBody } from '${up}/errors/index.ts';\nconst m = error.message;`,
			],
			[
				'tools/tool_d/server/index.ts',
				`import { harvestFetch } from '${up}/harvest/harvest.ts';\ntry { await harvestFetch(u) } catch (e) { out.push(toErrorBody(toDedaloError(e))) }`,
			],
			[
				// The interactive profile's holders are censused for disclosure too — the seed
				// list above REPLACES the key's, so this row fails if it forgets the name.
				'tools/tool_e/server/index.ts',
				`import { interactiveFetch } from '${up}/harvest/harvest.ts';\ntry { await interactiveFetch(u) } catch (e) { out.push(e.message) }`,
			],
		]);
		expect(messageDisclosures(synthetic)).toEqual([
			'tools/tool_a/server/index.ts',
			'tools/tool_b/server/index.ts',
			'tools/tool_e/server/index.ts',
		]);
	});

	test('no module but the guard spells an address reason (read them with isAddressRefusal)', () => {
		expect(ADDRESS_REASONS.length).toBeGreaterThan(4); // the table is read, not empty
		const guard = scanned.find((entry) => entry.file === GUARD);
		expect(reasonCopies(guard === undefined ? [] : [{ ...guard, file: 'x.ts' }])).toEqual(['x.ts']);
		expect(
			reasonCopies([
				{ file: 'copy.ts', code: "if (error.coordinates?.reason === 'dns_failed') throw error;" },
				{ file: 'fine.ts', code: "if (isAddressRefusal(error)) throw error; const r = 'dns';" },
			]),
		).toEqual(['copy.ts']);
		expect(reasonCopies(scanned)).toEqual([]);
	});
});

describe('isLoopbackHost: the bugs every hand-rolled copy carried', () => {
	test('bracketed IPv6 loopback matches (the dead-code arm)', () => {
		expect(new URL('http://[::1]/').hostname).toBe('[::1]');
		expect(isLoopbackHost(new URL('http://[::1]/').hostname)).toBe(true);
	});

	test('the whole loopback family, not just 127.0.0.1', () => {
		for (const host of [
			'127.0.0.1',
			'127.0.0.2', // every copy missed this
			'127.255.255.254',
			'0.0.0.0', // and this
			'',
			'localhost',
			'LOCALHOST',
			'localhost.', // the fully-qualified spelling of the same name
			'evil.localhost', // RFC 6761: the whole TLD is loopback
			'ip6-localhost',
			'[::]',
			'[::ffff:127.0.0.1]',
			'[::ffff:7f00:1]', // ...and the hex form the URL parser emits
			'[::1%lo0]',
		]) {
			expect(isLoopbackHost(host), `${host} must read as loopback`).toBe(true);
		}
	});

	test('a LAN origin stays VALID — it is private, but it is reachable', () => {
		// The over-block that would have broken the docker museum install, which
		// fetches its releases from the master over a LAN address. This is why the
		// question is loopback and NOT isPrivateIp.
		for (const host of [
			'192.168.1.40',
			'10.0.0.7',
			'master.dedalo.dev',
			'93.184.216.34',
			'127.0.0.1.evil.com',
			'notlocalhost',
		]) {
			expect(isLoopbackHost(host), `${host} must NOT read as loopback`).toBe(false);
		}
	});
});

describe('the IPv4-mapped IPv6 bypass (found 2026-08-31, pre-existing)', () => {
	test('the URL parser REWRITES the dotted form into hex', () => {
		// This is the whole mechanism: the guard checked only the dotted tail, and
		// no address arriving as a URL ever HAS a dotted tail.
		expect(new URL('http://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
	});

	test('isPrivateIp reads BOTH spellings of a mapped address', () => {
		for (const ip of [
			'::ffff:127.0.0.1',
			'::ffff:7f00:1', // loopback, hex — read as PUBLIC before the fix
			'::ffff:10.0.0.1',
			'::ffff:a00:1', // 10.0.0.1
			'::ffff:c0a8:1', // 192.168.0.1
			'::ffff:a9fe:a9fe', // 169.254.169.254 — the cloud metadata endpoint
		]) {
			expect(isPrivateIp(ip), `${ip} must be private`).toBe(true);
		}
		expect(isPrivateIp('::ffff:5db8:d822')).toBe(false); // 93.184.216.34, public
	});

	test('assertPublicUrl refuses the mapped-loopback URL end to end', async () => {
		for (const uri of [
			'http://[::ffff:127.0.0.1]/x',
			'http://[::ffff:7f00:1]/x',
			'http://[::ffff:a00:1]/x',
			'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
		]) {
			expect(await isPublicUrl(uri), `${uri} must be refused`).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// THE ATTACKER-AAAA TRUTH TABLE (SURF-2, 2026-09-30)
// ---------------------------------------------------------------------------

/*
 * Every way an IPv6 address can CARRY an IPv4 — standardized (mapped, NAT64 /96),
 * local-use NAT64 in every RFC 6052 layout, the deprecated IPv4-compatible and SIIT
 * forms, the 6to4 and Teredo tunnels, a DISCOVERED network-specific prefix and a
 * DECLARED one at every layout — crossed with non-public and public payloads, plus the
 * special blocks, a first-hextet allowlist sweep and multi-record answers. Each row is
 * the AAAA an attacker's own DNS server hands out for `attacker.test`, and it is driven
 * through EVERY consumer of the address policy:
 *
 *   1. assertPublicUrl('http://attacker.test/', {lookup}) — refused `private_resolved`,
 *      or passes returning exactly the row;
 *   2. assertPublicUrl on the literal `http://[row]/` — `private_literal`, or passes;
 *   3. isPrivateIp(row) — the synchronous verdict, equal to 2;
 *   4. isSafeLocalAsrUrl('http://[row]/') — the on-premise transcriber's policy. With
 *      the private-host exemption ON it refuses iff the row reaches a cloud metadata
 *      address through ANY carrier (or is one, or is a tunnel) and ALLOWS loopback and
 *      RFC 1918 payloads (so the exemption is not over-blocked); OFF it equals 2.
 *   5. claimedIpv4s(row) — the guard's ONE answer to "which IPv4 may this reach", which
 *      the transcriber already reads for every form of its host (consumer 4 judges each
 *      claim; its own redundant copy of the deprecated/local-use tables is PENDING
 *      deletion): it must hold every IPv4 the oracle says the row's carrier may deliver
 *      (tighten-only superset) — and, under an authoritative carrier, no spurious
 *      layout reading, or consumer 4 with the exemption OFF refuses what 2 accepts.
 *
 * THE ORACLE IS THE TEST'S OWN: an RFC 6052 §2.2 encoder/decoder, a byte parser, the
 * metadata set and the tunnel blocks are written here, never read from the guard — a
 * table derived from the code under test agrees with any bug in it.
 *
 * A REGRESSION LOCK, not a red-first reproduction: at the sha this block was written
 * the guard's verdict path already matched it (the allowlist landed 2026-09-29), and
 * the one open class — the transcriber judging carriers with tables of its own — is
 * behaviour-equal until one copy drifts. Its teeth are the mutations recorded below
 * (SURF-2 closure plan §D), each of which must turn this block red.
 *
 * MUTATIONS — run 2026-09-30 against src/core/security/ssrf_guard.ts, each applied
 * alone, each RED (this file + guarded_text_pin_native + outbound_fetch_tripwire):
 *   M1  TUNNEL_IPV6 = []                     6to4 public rows pass 1-3; tunnel metadata allowed (4 on)
 *   M1b drop '2001::/32' only                Teredo rows allowed by the transcriber (4 on)
 *   M2  drop '64:ff9b::/96'                  NAT64 public control refused
 *   M3  drop '::ffff:0:0/96'                 mapped public control refused
 *   M4  no 2000::/3 check (a blocklist)      sweep, fec0::1, 100::1, compat rows pass
 *   M5  carried isNonPublicIpv4 deleted      mapped / NAT64 / declared non-public rows pass
 *   M6  drop 2001:db8::/32 | 3fff::/20 | 2001::/23, one at a time — its row passes
 *   M7  discovered prefix authoritative      hostile-mode public rows pass (3, 4 off)
 *   M8  discoveredNat64 → []                 discovered non-public rows pass (1, 2)
 *   M9  no unbracket                         literal rows answer dns_failed
 *   M10 vet addresses.slice(0, 1)            multi-record rows pass
 *   M11 declaredNat64 → no prefixes          declared non-public rows pass
 *   M12 deprecated embeddings not claimed    compat/SIIT rows: claimedIpv4s misses the payload (5)
 *   M13 LOCAL_USE_LAYOUTS = [96]             local-use /48-/64 rows: claimedIpv4s misses it (5)
 *   M14 fetchGuardedText = assertPublicUrl + fetchBoundedText — pin gate red (rebinding case)
 *   M15 fetchGuardedText follows the Location — the pin gate's 3xx case red
 *   M16 possibleIpv4s also read under an authoritative carrier — declared local-use
 *       rows: the transcriber (4, exemption OFF) refuses the public payload the guard
 *       accepts, and claimedIpv4s is not the declared reading (5)
 * M12/M13 bite through consumer 5 while the transcriber still carries its own copy of
 * those tables; once it reads only `claimedIpv4s` they bite through consumer 4 too.
 */

/** The test's OWN IPv6 text → 16 bytes (hex groups and at most one `::`). */
function oracleV6(text: string): Uint8Array {
	const [head = '', tail] = text.split('::');
	const groups = (part: string): number[] =>
		part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));
	const left = groups(head);
	const right = tail === undefined ? [] : groups(tail);
	const zeros = new Array<number>(8 - left.length - right.length).fill(0);
	return Uint8Array.from([...left, ...zeros, ...right].flatMap((h) => [h >> 8, h & 0xff]));
}

/** 16 bytes → uncompressed IPv6 text (valid for isIP and URL). */
function oracleText(bytes: Uint8Array): string {
	const hextets: string[] = [];
	for (let at = 0; at < 16; at += 2) {
		hextets.push((((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0)).toString(16));
	}
	return hextets.join(':');
}

function oracleV4(text: string): Uint8Array {
	return Uint8Array.from(text.split('.').map(Number));
}

/** The byte positions an RFC 6052 layout of `bits` puts the IPv4 in (byte 8, the u octet, skipped). */
function layoutPositions(bits: number): number[] {
	const positions: number[] = [];
	for (let at = bits >> 3; positions.length < 4; at++) if (at !== 8) positions.push(at);
	return positions;
}

/** RFC 6052 §2.2: `prefix`'s first `bits`, then the IPv4 around the u octet, zero suffix. */
function embedV4(prefix: string, bits: number, v4: Uint8Array): Uint8Array {
	const bytes = new Uint8Array(16);
	bytes.set(oracleV6(prefix).subarray(0, bits >> 3));
	layoutPositions(bits).forEach((position, index) => {
		bytes[position] = v4[index] ?? 0;
	});
	return bytes;
}

function decodeV4(bytes: Uint8Array, bits: number): Uint8Array {
	return Uint8Array.from(layoutPositions(bits).map((position) => bytes[position] ?? 0));
}

const NON_PUBLIC_PAYLOADS = [
	'127.0.0.1',
	'10.0.0.1',
	'172.16.0.1',
	'192.168.0.1',
	'169.254.169.254',
	'100.100.100.200',
	'100.64.0.1',
	'0.0.0.0',
	'192.0.0.170',
	'198.18.0.1',
	'224.0.0.1',
	'240.0.0.1',
] as const;
const PUBLIC_PAYLOADS = ['93.184.216.34', '8.8.8.8'] as const;
const PAYLOADS = [
	...NON_PUBLIC_PAYLOADS.map((text) => ({ text, public: false })),
	...PUBLIC_PAYLOADS.map((text) => ({ text, public: true })),
];

/**
 * The documented cloud metadata set (transcription_local_asr's header): 169.254/16,
 * 100.100.100.200, 192.0.0.192, AWS IPv6 IMDS, GCE IPv6 metadata. Held HERE; its
 * equality with the transcriber's set is measured at the boundaries below.
 */
function isMetadataV4(v4: Uint8Array): boolean {
	const dotted = [...v4].join('.');
	return (
		(v4[0] === 169 && v4[1] === 254) || dotted === '100.100.100.200' || dotted === '192.0.0.192'
	);
}
const METADATA_V6 = ['fd00:ec2::254', 'fd20:ce::254'].map((text) => oracleText(oracleV6(text)));
function isMetadataV6(bytes: Uint8Array): boolean {
	return METADATA_V6.includes(oracleText(bytes));
}

/** 6to4 2002::/16 and Teredo 2001::/32, by the test's own bytes. */
function isTunnelOracle(bytes: Uint8Array): boolean {
	const first = ((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0);
	return first === 0x2002 || (first === 0x2001 && bytes[2] === 0 && bytes[3] === 0);
}

interface TruthRow {
	readonly label: string;
	readonly address: string;
	/** Refused by the public-address guard (consumers 1-3; 4 with the exemption off). */
	readonly refused: boolean;
	/** Refused by the transcriber with the private-host exemption ON. */
	readonly asrForbidden: boolean;
	/** Extra `ipv4only.arpa` AAAA answers this row's network reports (RFC 7050). */
	readonly discovery: readonly string[];
	/** Every IPv4 (dotted) the oracle says this row's carrier may deliver to. */
	readonly carried: readonly string[];
}

/** A row from bytes and the IPv4s its carrier may deliver to. */
function truthRow(
	label: string,
	bytes: Uint8Array,
	refused: boolean,
	carried: readonly Uint8Array[],
	discovery: readonly string[] = [],
): TruthRow {
	const asrForbidden = isTunnelOracle(bytes) || isMetadataV6(bytes) || carried.some(isMetadataV4);
	const dotted = carried.map((v4) => [...v4].join('.'));
	return { label, address: oracleText(bytes), refused, asrForbidden, discovery, carried: dotted };
}

interface Carrier {
	readonly label: string;
	readonly place: (v4: Uint8Array) => Uint8Array;
	/** A public payload settles it as public (the carrier is authoritative and routable). */
	readonly publicPasses: boolean;
	/** Every layout the carrier may be read in (the transcriber refuses a metadata hit in any). */
	readonly layouts: readonly number[];
	readonly discovery?: readonly string[];
}

const LOCAL_USE_LAYOUTS = [48, 56, 64, 96] as const;

function tunnelPlace(first: number, at: number): (v4: Uint8Array) => Uint8Array {
	return (v4) => {
		const bytes = new Uint8Array(16);
		bytes[0] = first >> 8;
		bytes[1] = first & 0xff;
		bytes.set(v4, at);
		if (first === 0x2002) bytes[15] = 1; // 2002:V4::1
		return bytes;
	};
}

const CARRIERS: readonly Carrier[] = [
	{
		label: 'mapped ::ffff:0:0/96',
		place: (v4) => embedV4('::ffff:0:0', 96, v4),
		publicPasses: true,
		layouts: [96],
	},
	{
		label: 'NAT64 64:ff9b::/96',
		place: (v4) => embedV4('64:ff9b::', 96, v4),
		publicPasses: true,
		layouts: [96],
	},
	...LOCAL_USE_LAYOUTS.map((bits) => ({
		label: `local-use 64:ff9b:1::/48 at /${bits} (undeclared)`,
		place: (v4: Uint8Array) => embedV4('64:ff9b:1::', bits, v4),
		publicPasses: false,
		layouts: LOCAL_USE_LAYOUTS,
	})),
	{
		label: 'IPv4-compatible ::/96',
		place: (v4) => embedV4('::', 96, v4),
		publicPasses: false,
		layouts: [96],
	},
	{
		label: 'SIIT ::ffff:0:0:0/96',
		place: (v4) => embedV4('::ffff:0:0:0', 96, v4),
		publicPasses: false,
		layouts: [96],
	},
	{ label: '6to4 2002:V4::1', place: tunnelPlace(0x2002, 2), publicPasses: false, layouts: [] },
	{ label: 'Teredo 2001:0:V4::', place: tunnelPlace(0x2001, 4), publicPasses: false, layouts: [] },
	{
		label: 'discovered 2c0f:f248:64::/96',
		place: (v4) => embedV4('2c0f:f248:64::', 96, v4),
		publicPasses: true,
		layouts: [96],
		discovery: ['2c0f:f248:64::c000:aa'],
	},
];

function carrierRows(carrier: Carrier): TruthRow[] {
	return PAYLOADS.map((payload) => {
		const bytes = carrier.place(oracleV4(payload.text));
		const carried = carrier.layouts.map((bits) => decodeV4(bytes, bits));
		const refused = !payload.public || !carrier.publicPasses;
		return truthRow(
			`${carrier.label} ← ${payload.text}`,
			bytes,
			refused,
			carried,
			carrier.discovery,
		);
	});
}

const SPECIAL_REFUSED = [
	'fec0::1',
	'2001:db8::1',
	'2001:db8:64::a9fe:a9fe',
	'3fff::1',
	'2001:2::1',
	'::',
	'::1',
	'fe80::1',
	'fc00::1',
	'fd00:ec2::254',
	'ff02::1',
	'100::1',
];
const SPECIAL_PASS = ['2606:4700:4700::1111', '2a00:1450:4001:830::200e'];

function specialRows(): TruthRow[] {
	return [
		...SPECIAL_REFUSED.map((text) => truthRow(`special ${text}`, oracleV6(text), true, [])),
		...SPECIAL_PASS.map((text) => truthRow(`special ${text}`, oracleV6(text), false, [])),
	];
}

/** `XX00::1` for every first octet: only 0x20-0x3f (2000::/3) is public. */
function sweepRows(): TruthRow[] {
	return Array.from({ length: 256 }, (_, octet) => {
		const text = `${octet.toString(16)}00::1`;
		return truthRow(`sweep ${text}`, oracleV6(text), octet < 0x20 || octet > 0x3f, []);
	});
}

const TRUTH_ROWS: readonly TruthRow[] = [
	...CARRIERS.flatMap(carrierRows),
	...specialRows(),
	...sweepRows(),
];

/** Multi-record answers: ONE bad record among good ones refuses the name. */
const MULTI_RECORD_ROWS: readonly (readonly string[])[] = [
	['2606:4700:4700::1111', '64:ff9b::7f00:1'],
	['93.184.216.34', '::ffff:7f00:1'],
];

interface DiscoveryMode {
	readonly name: string;
	/** What `ipv4only.arpa` answers on this network. */
	readonly ipv4only: readonly string[];
	/** Rows only this network's (hostile) discovery makes meaningful. */
	readonly extraRows: readonly TruthRow[];
}

/**
 * A HOSTILE resolver that says "your NAT64 prefix is fd00::/96" must not turn a
 * unique-local address into an accepted one: every row inside it stays refused, and a
 * metadata payload it claims is still refused by the transcriber.
 */
const HOSTILE_ULA_ROWS: readonly TruthRow[] = PAYLOADS.map((payload) => {
	const bytes = embedV4('fd00::', 96, oracleV4(payload.text));
	return truthRow(`hostile-discovered fd00::/96 ← ${payload.text}`, bytes, true, [
		decodeV4(bytes, 96),
	]);
});

const DISCOVERY_MODES: readonly DiscoveryMode[] = [
	{ name: 'no DNS64', ipv4only: ['192.0.0.170'], extraRows: [] },
	{ name: 'hostile ULA', ipv4only: ['fd00::c000:aa'], extraRows: HOSTILE_ULA_ROWS },
	// 64:ff9b:1::5db8:d822 is a local-use /96 row above: refused whatever discovery says.
	{ name: 'hostile local-use', ipv4only: ['64:ff9b:1::c000:aa'], extraRows: [] },
];

/** The attacker's DNS: `attacker.test` → the row, `ipv4only.arpa` → the mode, else ENOTFOUND. */
function attackerLookup(records: readonly string[], ipv4only: readonly string[]): AddressLookup {
	return async (host) => {
		const answer = host === 'attacker.test' ? records : host === 'ipv4only.arpa' ? ipv4only : null;
		if (answer === null) throw new Error(`ENOTFOUND ${host}`);
		return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
	};
}

/** `pass:<addresses>`, the refusal reason, or `unexpected:<error>` (never an address refusal). */
async function guardOutcome(uri: string, lookup: AddressLookup): Promise<string> {
	try {
		const { addresses } = await assertPublicUrl(uri, { lookup });
		return `pass:${addresses.join(',')}`;
	} catch (error) {
		if (!isAddressRefusal(error)) return `unexpected:${String(error)}`;
		return String((error as DedaloError).coordinates?.reason);
	}
}

/** The discovery cache a synchronous consumer on this network would hold: every /96 reported. */
function seededPrefixes(answers: readonly string[]): { network: Uint8Array; prefixBits: number }[] {
	return answers
		.filter((answer) => answer.includes(':'))
		.map((answer) => {
			const network = oracleV6(answer);
			network.fill(0, 12);
			return packCidr(`${oracleText(network)}/96`) as { network: Uint8Array; prefixBits: number };
		});
}

const EXEMPTION = 'DEDALO_TRANSCRIBER_ALLOW_PRIVATE_HOSTS';
const originalExemption = process.env[EXEMPTION];

/** Pinned, never deleted: a deleted key falls back to ../private/.env through readEnv. */
function setExemption(on: boolean): void {
	process.env[EXEMPTION] = on ? 'true' : '';
}

/** Per-consumer pass/refusal tallies and the executed-row count (anti-vacuity). */
const tally = {
	rows: 0,
	resolved: { pass: 0, refused: 0 },
	literal: { pass: 0, refused: 0 },
	isPrivateIp: { pass: 0, refused: 0 },
	asr: { pass: 0, refused: 0 },
	/** Rows whose carried IPv4s were checked against claimedIpv4s (consumer 5). */
	claims: 0,
};

function count(consumer: { pass: number; refused: number }, refused: boolean): void {
	if (refused) consumer.refused++;
	else consumer.pass++;
}

/** Consumers 1 and 2 on one row, mismatches as sentences. */
async function guardMismatches(row: TruthRow, mode: DiscoveryMode): Promise<string[]> {
	const lookup = attackerLookup([row.address], [...mode.ipv4only, ...row.discovery]);
	const resolved = await guardOutcome('http://attacker.test/', lookup);
	const literal = await guardOutcome(`http://[${row.address}]/`, lookup);
	count(tally.resolved, !resolved.startsWith('pass:'));
	count(tally.literal, !literal.startsWith('pass:'));
	const wantResolved = row.refused ? 'private_resolved' : `pass:${row.address}`;
	const wantLiteral = row.refused ? 'private_literal' : 'pass';
	const problems: string[] = [];
	if (resolved !== wantResolved) problems.push(`[resolved] want ${wantResolved} got ${resolved}`);
	if (literal.split(':')[0] !== wantLiteral)
		problems.push(`[literal] want ${wantLiteral} got ${literal}`);
	return problems.map((problem) => `${mode.name} / ${row.label} (${row.address}) ${problem}`);
}

/** Consumers 3 and 4 (synchronous) on one row, with the network's discovery cached. */
function syncMismatches(row: TruthRow, mode: DiscoveryMode): string[] {
	setNat64DiscoveryForTests({
		prefixes: seededPrefixes([...mode.ipv4only, ...row.discovery]),
		expiresAt: Date.now() + 10 * 60_000,
	});
	const uri = `http://[${row.address}]/`;
	const privateVerdict = isPrivateIp(row.address);
	setExemption(true);
	const asrOn = isSafeLocalAsrUrl(uri);
	setExemption(false);
	const asrOff = isSafeLocalAsrUrl(uri);
	const claimed = claimedIpv4s(oracleV6(row.address));
	const unclaimed = row.carried.filter((v4) => !claimed.includes(v4));
	if (row.carried.length > 0) tally.claims++;
	count(tally.isPrivateIp, privateVerdict);
	count(tally.asr, !asrOn);
	const problems: string[] = [];
	if (privateVerdict !== row.refused)
		problems.push(`[isPrivateIp] want ${row.refused} got ${privateVerdict}`);
	if (asrOn !== !row.asrForbidden)
		problems.push(`[asr exemption ON] want allowed=${!row.asrForbidden} got ${asrOn}`);
	if (asrOff !== !row.refused)
		problems.push(`[asr exemption OFF] want allowed=${!row.refused} got ${asrOff}`);
	if (unclaimed.length > 0)
		problems.push(`[claimedIpv4s] missing ${unclaimed.join(',')} (got ${claimed.join(',')})`);
	return problems.map((problem) => `${mode.name} / ${row.label} (${row.address}) ${problem}`);
}

describe('the attacker-AAAA truth table (SURF-2): every carrier × payload through every consumer', () => {
	const originalDiscovery = nat64DiscoveryState();
	beforeEach(() => {
		// Empty and UNEXPIRED: no consumer here may trigger a real ipv4only.arpa query.
		setNat64DiscoveryForTests({ prefixes: [], expiresAt: Date.now() + 10 * 60_000 });
		setExemption(false);
	});
	afterEach(() => {
		setNat64DiscoveryForTests(originalDiscovery);
		process.env[EXEMPTION] = originalExemption ?? '';
	});

	test('the oracle: the encoder round-trips through the guard’s RFC 6052 reader, at every layout', () => {
		for (const bits of [32, 40, 48, 56, 64, 96]) {
			for (const payload of PAYLOADS) {
				const v4 = oracleV4(payload.text);
				const bytes = embedV4('2a0b:4e00:6400:6400:64:6400::', bits, v4);
				expect([...(extractRfc6052Ipv4(bytes, bits) ?? [])], `/${bits} ${payload.text}`).toEqual([
					...v4,
				]);
				expect([...decodeV4(bytes, bits)]).toEqual([...v4]);
				expect(bytes[8], `/${bits}: the u octet carries no address bit`).toBe(
					bits >= 72 ? bytes[8] : 0,
				);
			}
		}
	});

	test('the payloads are what they claim: non-public refused, public not', () => {
		for (const text of NON_PUBLIC_PAYLOADS) expect(isPrivateIp(text), text).toBe(true);
		for (const text of PUBLIC_PAYLOADS) expect(isPrivateIp(text), text).toBe(false);
	});

	test('the metadata set held here IS the transcriber’s, measured at its boundaries', () => {
		setExemption(true);
		const members = [
			'169.254.0.0',
			'169.254.255.255',
			'100.100.100.200',
			'192.0.0.192',
			'[fd00:ec2::254]',
			'[fd20:ce::254]',
		];
		const neighbours = [
			'169.253.255.255',
			'169.255.0.0',
			'100.100.100.199',
			'100.100.100.201',
			'192.0.0.191',
			'192.0.0.193',
			'[fd00:ec2::253]',
			'[fd20:ce::255]',
		];
		for (const host of members)
			expect(isSafeLocalAsrUrl(`http://${host}/`), `${host} is metadata`).toBe(false);
		for (const host of neighbours)
			expect(isSafeLocalAsrUrl(`http://${host}/`), `${host} is not`).toBe(true);
	});

	test('the table is not vacuous: row floor, and every carrier row is really an IPv6 literal', () => {
		expect(TRUTH_ROWS.length).toBeGreaterThanOrEqual(400);
		expect(new Set(TRUTH_ROWS.map((row) => row.address)).size).toBeGreaterThan(380);
		expect(TRUTH_ROWS.some((row) => row.asrForbidden)).toBe(true);
		expect(TRUTH_ROWS.some((row) => !row.asrForbidden && row.refused)).toBe(true);
	});

	for (const mode of DISCOVERY_MODES) {
		const rows = [...TRUTH_ROWS, ...mode.extraRows];

		test(`${mode.name}: assertPublicUrl — the attacker's AAAA and the literal`, async () => {
			const problems: string[] = [];
			for (const row of rows) problems.push(...(await guardMismatches(row, mode)));
			tally.rows += rows.length;
			expect(problems).toEqual([]);
		});

		test(`${mode.name}: isPrivateIp and isSafeLocalAsrUrl (exemption on and off)`, () => {
			const problems = rows.flatMap((row) => syncMismatches(row, mode));
			expect(problems).toEqual([]);
		});

		test(`${mode.name}: multi-record answers — one bad record refuses the name`, async () => {
			for (const records of MULTI_RECORD_ROWS) {
				const outcome = await guardOutcome(
					'http://attacker.test/',
					attackerLookup(records, mode.ipv4only),
				);
				expect(outcome, records.join(' + ')).toBe('private_resolved');
			}
		});
	}

	test('every row ran, and every consumer both passed and refused something', () => {
		const expected = DISCOVERY_MODES.reduce(
			(sum, mode) => sum + TRUTH_ROWS.length + mode.extraRows.length,
			0,
		);
		expect(tally.rows).toBe(expected);
		expect(tally.claims, 'consumer 5 checked no carried IPv4 at all').toBeGreaterThan(100);
		for (const consumer of [tally.resolved, tally.literal, tally.isPrivateIp, tally.asr]) {
			expect(consumer.pass).toBeGreaterThan(0);
			expect(consumer.refused).toBeGreaterThan(0);
		}
	});
});

/*
 * A DECLARED network-specific prefix (DEDALO_NAT64_PREFIXES) is the operator's word:
 * AUTHORITATIVE. At every RFC 6052 layout a non-public payload is refused and a public
 * one passes, and the transcriber refuses a metadata payload through it. The prefixes
 * are synthetic global space, verified here to sit outside every special-purpose and
 * tunnel block, so it is the declaration — not some other rule — deciding each row.
 */
const DECLARED_PREFIXES: readonly (readonly [string, number])[] = [
	['2a0b:4e00::', 32],
	['2a0b:4e01:6400::', 40],
	['2a0b:4e02:64::', 48],
	['2a0b:4e03:64:6400::', 56],
	['2a0b:4e04:64:64::', 64],
	['2a0b:4e05:64:64:0:64::', 96],
];

/** The test's own copy of the special blocks inside 2000::/3 (prefix text, bits). */
const SPECIAL_GLOBAL_BLOCKS: readonly (readonly [string, number])[] = [
	['2001::', 23],
	['2001:db8::', 32],
	['3fff::', 20],
	['2002::', 16],
	['2001::', 32],
];

function inBlock(bytes: Uint8Array, block: readonly [string, number]): boolean {
	const network = oracleV6(block[0]);
	for (let bit = 0; bit < block[1]; bit++) {
		const mask = 0x80 >> (bit & 7);
		if (((bytes[bit >> 3] ?? 0) & mask) !== ((network[bit >> 3] ?? 0) & mask)) return false;
	}
	return true;
}

describe('the attacker-AAAA truth table: a DECLARED NAT64 prefix at every layout', () => {
	const originalDiscovery = nat64DiscoveryState();
	beforeEach(() => {
		process.env[NAT64_SETTING] = DECLARED_PREFIXES.map(
			([prefix, bits]) => `${prefix}/${bits}`,
		).join(',');
		setNat64DiscoveryForTests({ prefixes: [], expiresAt: Date.now() + 10 * 60_000 });
		setExemption(false);
	});
	afterEach(() => {
		setNat64DiscoveryForTests(originalDiscovery);
		process.env[EXEMPTION] = originalExemption ?? '';
	});

	const rows = DECLARED_PREFIXES.flatMap(([prefix, bits]) =>
		PAYLOADS.map((payload) => {
			const bytes = embedV4(prefix, bits, oracleV4(payload.text));
			return truthRow(`declared ${prefix}/${bits} ← ${payload.text}`, bytes, !payload.public, [
				decodeV4(bytes, bits),
			]);
		}),
	);

	test('the declared prefixes are global unicast outside every special and tunnel block', () => {
		for (const [prefix] of DECLARED_PREFIXES) {
			const bytes = oracleV6(prefix);
			expect(inBlock(bytes, ['2000::', 3]), prefix).toBe(true);
			for (const block of SPECIAL_GLOBAL_BLOCKS)
				expect(inBlock(bytes, block), `${prefix} in ${block[0]}/${block[1]}`).toBe(false);
		}
		expect(rows.length).toBe(DECLARED_PREFIXES.length * PAYLOADS.length);
	});

	test('assertPublicUrl, isPrivateIp and isSafeLocalAsrUrl honour the declaration', async () => {
		const mode = DISCOVERY_MODES[0] as DiscoveryMode;
		const problems: string[] = [];
		for (const row of rows)
			problems.push(...(await guardMismatches(row, mode)), ...syncMismatches(row, mode));
		expect(problems).toEqual([]);
		expect(rows.some((row) => row.refused) && rows.some((row) => !row.refused)).toBe(true);
	});
});

/*
 * A DECLARED prefix INSIDE RFC 8215's local-use block, `64:ff9b:1::/48` — the case the
 * guard documents as "honoured like any other", and the one the global-unicast
 * declared table above cannot build. The declaration fixes the layout: a public
 * payload passes every consumer, and the transcriber with the exemption OFF must
 * EQUAL the guard (consumer 4 = consumer 2). Measured 2026-09-30: reading the other
 * local-use layouts too (the zero suffix of a /48 embedding reads as 0.0.0.0 at /96)
 * made the transcriber refuse `64:ff9b:1:5db8:d8:2200::` — 93.184.216.34, declared
 * public — while the guard accepted it. One prefix per run: two overlapping
 * declarations would let the first one's layout read the second one's addresses.
 */
const DECLARED_LOCAL_USE: readonly (readonly [string, number])[] = [
	['64:ff9b:1::', 48],
	['64:ff9b:1::', 96],
];

for (const [prefix, bits] of DECLARED_LOCAL_USE) {
	describe(`the attacker-AAAA truth table: a DECLARED local-use prefix ${prefix}/${bits}`, () => {
		const originalDiscovery = nat64DiscoveryState();
		beforeEach(() => {
			process.env[NAT64_SETTING] = `${prefix}/${bits}`;
			setNat64DiscoveryForTests({ prefixes: [], expiresAt: Date.now() + 10 * 60_000 });
			setExemption(false);
		});
		afterEach(() => {
			setNat64DiscoveryForTests(originalDiscovery);
			process.env[EXEMPTION] = originalExemption ?? '';
		});

		const rows = PAYLOADS.map((payload) => {
			const bytes = embedV4(prefix, bits, oracleV4(payload.text));
			return truthRow(`declared ${prefix}/${bits} ← ${payload.text}`, bytes, !payload.public, [
				decodeV4(bytes, bits),
			]);
		});

		test('the prefix really is inside the local-use block (so the declaration decides)', () => {
			for (const row of rows)
				expect(inBlock(oracleV6(row.address), ['64:ff9b:1::', 48])).toBe(true);
			expect(rows.some((row) => !row.refused)).toBe(true);
		});

		test('assertPublicUrl, isPrivateIp and isSafeLocalAsrUrl (exemption OFF equals the guard)', async () => {
			const mode = DISCOVERY_MODES[0] as DiscoveryMode;
			const problems: string[] = [];
			for (const row of rows)
				problems.push(...(await guardMismatches(row, mode)), ...syncMismatches(row, mode));
			expect(problems).toEqual([]);
		});

		test('claimedIpv4s under the declaration is exactly the declared reading', () => {
			for (const row of rows) {
				expect(claimedIpv4s(oracleV6(row.address)), row.label).toEqual([...row.carried]);
			}
		});
	});
}

// ---------------------------------------------------------------------------
// WHO READS CARRIERS (SURF-2 class: an address judged by carrier knowledge that is
// not the guard's)
// ---------------------------------------------------------------------------

/*
 * The truth table above measures the consumers it NAMES. A third module that builds
 * its own carrier table out of the byte primitives — an RFC 6052 reader, a block
 * matcher, a block packer — would judge addresses unmeasured, and that is exactly how
 * the transcriber's copy came to exist. So the primitives are censused by import
 * BINDING (the same resolver as the door census: renames, namespaces, barrels,
 * re-exports), and outside `src/core/security/` a module holds one only by a row
 * here. The rows may only SHRINK: a row whose module no longer holds the primitive is
 * red until it is deleted.
 *
 * ITS LIMIT: it sees the four NAMED block / RFC 6052 primitives, not a hand-rolled
 * comparison — a module that takes `packIpv6` (legitimately needed elsewhere), compares
 * the leading bytes to `::ffff:0:0/96` itself and slices `subarray(12, 16)` holds none
 * of them. That wider class is closed by OUTCOME in the next block (WHO JUDGES
 * ADDRESSES): every module outside the guard holding ANY address byte primitive is
 * registered, and an outbound one is driven through the truth table.
 */
const IP_ADDRESS = 'src/core/security/ip_address.ts';
const CARRIER_PRIMITIVE_SEEDS: Record<string, readonly string[]> = {
	[IP_ADDRESS]: ['extractRfc6052Ipv4', 'packedInBlock', 'packCidr'],
	[GUARD]: ['packBlocks'],
};

const CARRIER_PRIMITIVE_IMPORTERS: Record<
	string,
	{ primitives: readonly string[]; reason: string }
> = {
	'src/core/tools/transcription_local_asr.ts': {
		primitives: ['extractRfc6052Ipv4', 'packBlocks', 'packedInBlock'],
		reason:
			'PENDING DELETION (SURF-2 integrator request 1): its LEGACY_IPV4_EMBEDDINGS / ' +
			'LOCAL_USE_NAT64 tables re-read carriers the guard’s claimedIpv4s already answers — ' +
			'extractRfc6052Ipv4 goes with them. packBlocks/packedInBlock stay for METADATA_BLOCKS, ' +
			'the cloud metadata endpoints: a destination list, not a carrier.',
	},
};

function carrierViolations(census: Map<string, Set<string>>): string[] {
	const found: string[] = [];
	for (const [file, held] of census) {
		if (file.startsWith('src/core/security/')) continue;
		const allowed = new Set(CARRIER_PRIMITIVE_IMPORTERS[file]?.primitives ?? []);
		for (const primitive of held) {
			if (primitive === OPAQUE)
				found.push(`${file}: names a carrier module but loads a non-literal import()`);
			else if (!allowed.has(primitive))
				found.push(
					`${file}: holds ${primitive} — ask the guard (claimedIpv4s / embeddedIpv4 / isPrivateIp) ` +
						'which IPv4 an address reaches instead of building a carrier table of your own',
				);
		}
	}
	return found.sort();
}

describe('who reads carriers (import-graph census of the address primitives)', () => {
	const census = doorCensus(
		new Map(sourceFiles().map((entry) => [entry.file, entry.code])),
		CARRIER_PRIMITIVE_SEEDS,
	);

	test('no module outside the guard builds a carrier table without a written row', () => {
		expect(carrierViolations(census)).toEqual([]);
	});

	test('the rows may only SHRINK, and each carries a real reason', () => {
		const stale: string[] = [];
		for (const [file, row] of Object.entries(CARRIER_PRIMITIVE_IMPORTERS)) {
			expect(row.reason.length, file).toBeGreaterThan(80);
			const unused = row.primitives.filter(
				(primitive) => census.get(file)?.has(primitive) !== true,
			);
			if (unused.length > 0)
				stale.push(`${file}: no longer holds ${unused.join(', ')} — narrow or delete the row`);
		}
		expect(stale).toEqual([]);
	});

	test('the census sees a namespace, a rename and a barrel (synthetic tree)', () => {
		const synthetic = new Map<string, string>([
			[IP_ADDRESS, 'export function extractRfc6052Ipv4() {}'],
			[GUARD, 'export function packBlocks() {}'],
			[
				'src/core/x/namespace.ts',
				"import * as ip from '../security/ip_address.ts';\nexport const read = ip.extractRfc6052Ipv4;",
			],
			[
				'src/core/x/rename.ts',
				"import { packBlocks as blocks } from '../security/ssrf_guard.ts';\nblocks([]);",
			],
			[
				'src/core/x/barrel.ts',
				"export { packedInBlock as inside } from '../security/ip_address.ts';",
			],
			['tools/tool_y/server/index.ts', "import { inside } from '../../../src/core/x/barrel.ts';"],
			['src/core/x/clean.ts', "import { formatIpv4 } from '../security/ip_address.ts';"],
		]);
		const found = carrierViolations(doorCensus(synthetic, CARRIER_PRIMITIVE_SEEDS));
		const holders = new Set(found.map((line) => line.split(':')[0]));
		expect([...holders].sort()).toEqual([
			'src/core/x/barrel.ts',
			'src/core/x/namespace.ts',
			'src/core/x/rename.ts',
			'tools/tool_y/server/index.ts',
		]);
	});
});

// ---------------------------------------------------------------------------
// WHO JUDGES ADDRESSES (the wider SURF-2 class, closed by outcome)
// ---------------------------------------------------------------------------

/*
 * The carrier census above names four primitives; a module can still judge an address
 * with a table of its own built from the plain byte parsers (`packIpv6`, `packAddress`
 * …). So EVERY address byte primitive of ip_address.ts (and the guard's block packer)
 * is censused by binding, and outside `src/core/security/` a holder needs a row saying
 * which way it judges:
 *
 *   - `outbound` — it decides where the server may CONNECT. Its row names the exported
 *     predicate `(uri) => boolean | Promise<boolean>` (true = allowed), and that
 *     predicate is DRIVEN here through every truth-table row with every exemption OFF:
 *     it must equal the guard. Registering a new outbound module is what puts it under
 *     the table — the verdict is measured, not the spelling.
 *   - `inbound` — it judges a CLIENT's address against an operator allowlist (no
 *     destination, no carrier question); its reason says so.
 *
 * Rows may only SHRINK (a row whose module holds no primitive is red). The census's
 * own limit: a module that parses addresses with NO primitive of ip_address.ts (its own
 * regex, `node:net`) is invisible to it — review-diff's ssrf-egress lens owns that.
 */
const ADDRESS_BYTE_SEEDS: Record<string, readonly string[]> = {
	[IP_ADDRESS]: [
		'peerBytes',
		'sameBytes',
		'sameAddress',
		'packIpv4',
		'packIpv6',
		'packAddress',
		'ipInCidr',
		'peerBlock',
		'packCidr',
		'packedInBlock',
		'extractRfc6052Ipv4',
	],
	[GUARD]: ['packBlocks'],
};

type AddressJudgeRow =
	| { direction: 'outbound'; predicate: string; reason: string }
	| { direction: 'inbound'; reason: string };

const ADDRESS_JUDGES: Record<string, AddressJudgeRow> = {
	'src/core/tools/transcription_local_asr.ts': {
		direction: 'outbound',
		predicate: 'isSafeLocalAsrUrl',
		reason:
			'the on-premise transcriber’s destination policy (the private-host exemption); with ' +
			'the exemption OFF it must be the guard, which the drive below measures row by row.',
	},
};

function addressJudgeViolations(census: Map<string, Set<string>>): string[] {
	const found: string[] = [];
	for (const [file, held] of census) {
		if (file.startsWith('src/core/security/')) continue;
		if (held.has(OPAQUE))
			found.push(`${file}: names an address module but loads a non-literal import()`);
		else if (ADDRESS_JUDGES[file] === undefined)
			found.push(
				`${file}: holds ${[...held].sort().join(', ')} — register it in ADDRESS_JUDGES ` +
					'(outbound: its predicate is driven through the truth table; inbound: why no ' +
					'destination is judged), or ask the guard instead',
			);
	}
	return found.sort();
}

describe('who judges addresses (every holder of an address byte primitive is registered)', () => {
	const census = doorCensus(
		new Map(sourceFiles().map((entry) => [entry.file, entry.code])),
		ADDRESS_BYTE_SEEDS,
	);

	test('no module outside the guard judges addresses without a row', () => {
		expect(addressJudgeViolations(census)).toEqual([]);
	});

	test('the rows may only SHRINK, and each carries a real reason', () => {
		const stale: string[] = [];
		for (const [file, row] of Object.entries(ADDRESS_JUDGES)) {
			expect(row.reason.length, file).toBeGreaterThan(80);
			if ((census.get(file)?.size ?? 0) === 0)
				stale.push(`${file}: holds no address primitive — delete the row`);
		}
		expect(stale).toEqual([]);
	});

	test('the census sees a plain byte parser behind a barrel (synthetic tree)', () => {
		const synthetic = new Map<string, string>([
			[IP_ADDRESS, 'export function packIpv6() {}'],
			[GUARD, 'export function packBlocks() {}'],
			[
				'src/core/x/hand_rolled.ts',
				"import { packIpv6 as parse } from '../security/ip_address.ts';\n" +
					'export const isOk = (h) => parse(h)?.subarray(12, 16);',
			],
			['src/core/x/barrel.ts', "export * from '../security/ip_address.ts';"],
			['tools/tool_y/server/index.ts', "import { packIpv6 } from '../../../src/core/x/barrel.ts';"],
		]);
		const found = addressJudgeViolations(doorCensus(synthetic, ADDRESS_BYTE_SEEDS));
		expect(found.map((line) => line.split(':')[0])).toEqual([
			'src/core/x/barrel.ts',
			'src/core/x/hand_rolled.ts',
			'tools/tool_y/server/index.ts',
		]);
	});
});

describe('every OUTBOUND address judge equals the guard on the truth table (exemptions off)', () => {
	const originalDiscovery = nat64DiscoveryState();
	beforeEach(() => setExemption(false));
	afterEach(() => {
		setNat64DiscoveryForTests(originalDiscovery);
		process.env[EXEMPTION] = originalExemption ?? '';
	});

	const outbound = Object.entries(ADDRESS_JUDGES).flatMap(([file, row]) =>
		row.direction === 'outbound' ? [{ file, predicate: row.predicate }] : [],
	);

	test('at least one outbound judge is registered (the drive is not vacuous)', () => {
		expect(outbound.length).toBeGreaterThan(0);
	});

	for (const { file, predicate } of outbound) {
		test(`${file} ${predicate}: allowed exactly when the guard allows, every row`, async () => {
			const module = (await import(join(process.cwd(), file))) as Record<string, unknown>;
			const judge = module[predicate];
			expect(typeof judge, `${file} exports ${predicate}`).toBe('function');
			const mode = DISCOVERY_MODES[0] as DiscoveryMode;
			const problems: string[] = [];
			let allowed = 0;
			for (const row of TRUTH_ROWS) {
				setNat64DiscoveryForTests({
					prefixes: seededPrefixes([...mode.ipv4only, ...row.discovery]),
					expiresAt: Date.now() + 10 * 60_000,
				});
				const verdict = await (judge as (uri: string) => boolean | Promise<boolean>)(
					`http://[${row.address}]/`,
				);
				if (verdict) allowed++;
				if (verdict !== !row.refused)
					problems.push(
						`${row.label} (${row.address}) want allowed=${!row.refused} got ${verdict}`,
					);
			}
			expect(problems).toEqual([]);
			expect(allowed > 0 && allowed < TRUTH_ROWS.length, 'both verdicts occurred').toBe(true);
		});
	}
});

// ---------------------------------------------------------------------------
// THE GEO SERVICES MODULE — a `fetchGuardedText` CALLER with a closed table, not a door.
//
// `src/core/geo_services/` asks five providers a handful of fixed questions (a place name, a
// parcel, an elevation): `callGeoService(id, params)` takes an id from a closed table and
// parameters from a closed grammar, builds the address itself and dials through the public
// single-call door (engineering/OUTBOUND_SPEC.md §2). It is WRAPPER, and this census
// deliberately does not follow a wrapper: a tool that imports `callGeoService` reaches
// `fetchGuardedText` without holding it, which is exactly the point — it can ask the table's
// questions and no other. So what is pinned here is the wrapper's own shape, exact both ways:
//   - ONE module of the directory holds a raw door, and the door it holds is `fetchGuardedText`
//     alone (not the pinned hop, not the unpinned text door, not the redirect loop, neither
//     harvest profile, not the agent channel);
//   - that module's runtime exports are exactly the entry point — never a function a caller
//     could hand a URL to (the same reading a route is held to) — and the entry point takes
//     the id and the parameters and NOTHING ELSE: the text door's seams (the resolver and the
//     socket, which ARE the SSRF guard's pin and address vetting) are not a parameter;
//   - those seams ride a scope (`geo_seams.ts`: `runWithGeoServiceSeams`) that NO module of
//     src/ or tools/ may bind, by any route. That is read as a DOOR of the import-graph
//     census, so a named or renamed import, a namespace, `export … from`, a barrel inside
//     the module, a literal `import()` or `require()`, a re-exported `const` and a non-literal
//     `import()` in a file that names the module are all followed — not as a count of
//     arguments at the call sites of one spelling, which a dynamic import, a barrel or a
//     forwarder never trips;
//   - its gate exists, imports it, names the entry point and carries a real number of tests.
// Behaviour (the closed table, the request grammar, the typed failures, the pacing, the shared
// calls) is the gate's: test/unit/geo_services_native.test.ts.
// ---------------------------------------------------------------------------

const GEO_SERVICES_DIR = 'src/core/geo_services/';
/** The ONE geo services module that dials, and the ONE door it holds. */
const GEO_SERVICES_CALLER = `${GEO_SERVICES_DIR}call.ts`;
const GEO_SERVICES_DOOR = 'fetchGuardedText';
const GEO_SERVICES_ENTRY: readonly string[] = ['callGeoService'];
/** The module that carries the text door's seams, and the one name that opens their scope. */
const GEO_SEAMS_FILE = `${GEO_SERVICES_DIR}geo_seams.ts`;
const GEO_SEAM_DOOR = 'runWithGeoServiceSeams';
/** The seams scope, as a door-carrying module for the census. Its reader (`geoServiceSeams`) is not one. */
const GEO_SEAM_SEEDS: Record<string, readonly string[]> = { [GEO_SEAMS_FILE]: [GEO_SEAM_DOOR] };
const GEO_SERVICES_ROW: InteractiveRoute = {
	reason:
		'asks a provider from a closed table (id and parameter grammar, never an address), through ' +
		'the public single-call door, inside the provider’s own pacing, with typed failures',
	gate: 'test/unit/geo_services_native.test.ts',
	handlers: GEO_SERVICES_ENTRY,
};

/** Every problem with the geo services module's door use; empty when it is the shape above. */
function geoServicesProblems(
	census: ReadonlyMap<string, ReadonlySet<string>>,
	sources: ReadonlyMap<string, string>,
	row: InteractiveRoute = GEO_SERVICES_ROW,
	caller: string = GEO_SERVICES_CALLER,
): string[] {
	const problems: string[] = [];
	for (const [file, doors] of census) {
		if (!file.startsWith(GEO_SERVICES_DIR)) continue;
		const held = [...doors].sort().join(', ');
		if (file !== caller) {
			problems.push(
				`${file}: holds ${held} — only ${caller} may dial: one module is the one place the ` +
					'table’s requests become sockets',
			);
		} else if (held !== GEO_SERVICES_DOOR) {
			problems.push(
				`${file}: holds ${held} — the geo services use ${GEO_SERVICES_DOOR} and no other door`,
			);
		}
	}
	if (census.get(caller)?.has(GEO_SERVICES_DOOR) !== true) {
		problems.push(
			`${caller}: no longer holds ${GEO_SERVICES_DOOR} — a row for a debt already paid hides that it was paid`,
		);
	}
	problems.push(...entryParameterProblems(caller, sources.get(caller)));
	return [...problems, ...routeRowProblems(caller, row, sources)];
}

/** The parameter names `callGeoService` declares, or null when the caller has no such function. */
function entryParameters(file: string, source: string): string[] | null {
	let found: string[] | null = null;
	walkAst(parseProgram(file, source).body, [], (node) => {
		if (node.type !== 'FunctionDeclaration' || nameOf(node.id) !== GEO_SERVICES_ENTRY[0]) return;
		found = (node.params as AstNode[]).map((param) => {
			const target = param.type === 'AssignmentPattern' ? (param.left as AstNode) : param;
			return `${param.type === 'RestElement' ? '...' : ''}${nameOf(target)}`;
		});
	});
	return found;
}

/**
 * "The entry point takes no seam": `callGeoService(id, params)` — a third parameter, a rest
 * parameter or a destructured one would put a transport (the resolver, the socket) in a
 * caller's hands, and with it the SSRF guard's pin and address vetting.
 */
function entryParameterProblems(file: string, source: string | undefined): string[] {
	if (source === undefined) return [];
	const declared = entryParameters(file, source);
	if (declared === null) return [`${file}: declares no function ${GEO_SERVICES_ENTRY[0]}`];
	if (declared.join() === 'id,params') return [];
	return [
		`${file}: ${GEO_SERVICES_ENTRY[0]}(${declared.join(', ')}) — the entry point takes exactly ` +
			'(id, params): the text door’s seams are not a parameter (they ride geo_seams.ts)',
	];
}

/**
 * "Production supplies no seam": the text door's test seams (a resolver, a socket, the
 * limiter's clock) are what a gate drives the REAL guard through, and they are exactly what a
 * caller must never choose — whoever replaces the resolver or the socket replaces the SSRF
 * guard's pin and address vetting. They ride a scope (`geo_seams.ts`), opened by
 * `runWithGeoServiceSeams`, which is a door of the census below: the census follows every
 * binding to it, wherever the binding is written, so NO file of src/ or tools/ may hold it
 * (the module's one reader, `geoServiceSeams`, sets nothing and is not a door). A non-literal
 * `import()` in a file that names the seams module could be loading it and is refused too, and
 * so is a file that spells the opener's name without binding it (a computed property, say).
 */
function geoSeamProblems(
	sources: ReadonlyMap<string, string>,
	seams: string = GEO_SEAMS_FILE,
): string[] {
	const problems: string[] = [];
	const census = doorCensus(sources, { [seams]: [GEO_SEAM_DOOR] });
	for (const [file, doors] of census) {
		if (doors.has(GEO_SEAM_DOOR)) {
			problems.push(
				`${file}: binds ${GEO_SEAM_DOOR} — no production module may open the geo services’ test seams (an import, a re-export, a barrel, a load): they are the SSRF guard’s pin and address vetting`,
			);
		}
		if (doors.has(OPAQUE)) {
			problems.push(
				`${file}: names ${seams} but loads a non-literal import() — the census cannot see what it reaches`,
			);
		}
	}
	for (const [file, source] of sources) {
		if (file !== seams && source.includes(GEO_SEAM_DOOR) && !census.get(file)?.has(GEO_SEAM_DOOR)) {
			problems.push(`${file}: spells ${GEO_SEAM_DOOR} without binding it — read it as a bypass`);
		}
	}
	return problems.sort();
}

describe('the geo services module is a fetchGuardedText caller with a closed table, not a door', () => {
	const scanned = sourceFiles();
	const code = new Map(scanned.map((entry) => [entry.file, entry.code]));
	const gateText = readFileSync(join(REPO_ROOT, GEO_SERVICES_ROW.gate), 'utf8');

	test('the real module is exactly that shape (and the census saw it: anti-vacuity)', () => {
		const census = doorCensus(code, OUTBOUND_DOOR_SEEDS);
		const holders = [...census.keys()].filter((file) => file.startsWith(GEO_SERVICES_DIR));
		expect(holders, 'the one module that dials').toEqual([GEO_SERVICES_CALLER]);
		expect([...(census.get(GEO_SERVICES_CALLER) ?? [])]).toEqual([GEO_SERVICES_DOOR]);
		expect(code.get(GEO_SERVICES_CALLER) ?? '', 'the door is CALLED, not merely imported').toMatch(
			/fetchGuardedText\(/,
		);
		const sources = new Map(code);
		sources.set(GEO_SERVICES_ROW.gate, gateText);
		expect(geoServicesProblems(census, sources)).toEqual([]);
	});

	test('a wrapper is not a door: a tool that imports the entry point holds no raw door by binding', () => {
		// The census's stated limit, made a decision: the closed table is what the tool gets.
		const synthetic = new Map<string, string>([
			[GUARD, 'export async function fetchGuardedText() {}'],
			[
				GEO_SERVICES_CALLER,
				"import { fetchGuardedText } from '../security/ssrf_guard.ts';\nexport async function callGeoService(id, params) { await fetchGuardedText(u) }",
			],
			[
				'tools/tool_x/server/index.ts',
				"import { callGeoService } from '../../../src/core/geo_services/call.ts';\nawait callGeoService('nominatim_search', {});",
			],
		]);
		const census = doorCensus(synthetic, OUTBOUND_DOOR_SEEDS);
		expect(census.has('tools/tool_x/server/index.ts')).toBe(false);
		expect(doorViolations(census)).toEqual([]);
	});

	test('a second holder, a second door, a URL-taking export, a stale row and a hollow gate are each refused (synthetic tree)', () => {
		const guard =
			'export async function fetchGuardedText() {}\nexport async function fetchBoundedText() {}';
		const harvest =
			'export async function harvestFetch() {}\nexport async function interactiveFetch() {}';
		const caller = (extra = '', imports = 'fetchGuardedText', parameters = 'id, params'): string =>
			`import { ${imports} } from '../security/ssrf_guard.ts';\n${extra}export async function callGeoService(${parameters}) { await fetchGuardedText(u) }`;
		const gate = (tests = MIN_ROUTE_GATE_TESTS): string =>
			[
				"import { callGeoService } from '../../src/core/geo_services/call.ts';",
				...Array.from(
					{ length: tests },
					(_, i) => `test('clause ${i}', () => { expect(callGeoService).toBeDefined(); });`,
				),
			].join('\n');
		const problems = (over: Record<string, string | null> = {}): string[] => {
			const all: Record<string, string | null> = {
				[GUARD]: guard,
				[HARVEST_DOOR]: harvest,
				[GEO_SERVICES_CALLER]: caller(),
				[GEO_SERVICES_ROW.gate]: gate(),
				...over,
			};
			const sources = new Map(
				Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null),
			);
			return geoServicesProblems(doorCensus(sources, OUTBOUND_DOOR_SEEDS), sources);
		};

		expect(problems(), 'the sound shape passes').toEqual([]);
		// A second module of the directory that dials.
		expect(
			problems({
				[`${GEO_SERVICES_DIR}extra.ts`]:
					"import { fetchGuardedText as get } from '../security/ssrf_guard.ts';\nexport const x = get;",
			}).join('\n'),
		).toContain('extra.ts');
		// A second raw door in the caller, and the harvesting door's two profiles.
		expect(
			problems({ [GEO_SERVICES_CALLER]: caller('', 'fetchGuardedText, fetchBoundedText') }).join(
				'\n',
			),
		).toContain('no other door');
		for (const door of ['harvestFetch', 'interactiveFetch']) {
			expect(
				problems({
					[GEO_SERVICES_CALLER]: `${caller()}\nimport { ${door} } from '../harvest/harvest.ts';\nvoid ${door};`,
				}).join('\n'),
				door,
			).toContain('no other door');
		}
		// An export a caller could hand a URL to, a wildcard that hides the surface, a missing entry.
		expect(
			problems({
				[GEO_SERVICES_CALLER]: caller('export async function fetchUrl(url: string) {}\n'),
			}).join('\n'),
		).toContain('fetchUrl');
		expect(
			problems({ [GEO_SERVICES_CALLER]: caller("export * from './answers.ts';\n") }),
		).not.toEqual([]);
		expect(problems({ [GEO_SERVICES_CALLER]: caller('export const LIMIT = 1;\n') })).not.toEqual(
			[],
		);
		// Types are erased: they widen nothing.
		expect(problems({ [GEO_SERVICES_CALLER]: caller('export type R = string;\n') })).toEqual([]);
		// The entry point grew a parameter: a transport could be handed through it.
		expect(
			problems({
				[GEO_SERVICES_CALLER]: caller('', 'fetchGuardedText', 'id, params, deps = {}'),
			}).join('\n'),
		).toContain('takes exactly');
		// The caller stopped dialling: the census entry is stale.
		expect(
			problems({
				[GEO_SERVICES_CALLER]: 'export async function callGeoService(id, params) {}',
			}).join('\n'),
		).toContain('no longer holds');
		// A gate that is missing, thin, about something else, or asserts nothing.
		expect(problems({ [GEO_SERVICES_ROW.gate]: null })).not.toEqual([]);
		expect(problems({ [GEO_SERVICES_ROW.gate]: gate(MIN_ROUTE_GATE_TESTS - 1) })).not.toEqual([]);
		expect(
			problems({ [GEO_SERVICES_ROW.gate]: gate().replace('geo_services/call', 'other/thing') }),
		).not.toEqual([]);
		expect(
			problems({ [GEO_SERVICES_ROW.gate]: gate().replace(/expect\(/g, 'check(') }),
		).not.toEqual([]);
	});
	test('no production module can open the text door’s seams: the entry point takes none and the scope that carries them is bound by nobody (the real tree)', () => {
		expect(geoSeamProblems(code), 'src/ and tools/').toEqual([]);
		// Anti-vacuity: the census SAW the module that reads the scope, and the opener is a door of it.
		const seamCensus = doorCensus(code, GEO_SEAM_SEEDS);
		expect(seamCensus.has(GEO_SERVICES_CALLER), 'call.ts names the seams module').toBe(false);
		expect(code.get(GEO_SERVICES_CALLER) ?? '').toContain('geo_seams.ts');
		expect(code.get(GEO_SEAMS_FILE) ?? '').toContain(`export function ${GEO_SEAM_DOOR}`);
		expect(entryParameters(GEO_SERVICES_CALLER, code.get(GEO_SERVICES_CALLER) ?? '')).toEqual([
			'id',
			'params',
		]);
	});

	test('every route to the seams scope is followed — import, rename, namespace, re-export, barrel, literal load, require, re-exported const, non-literal load (synthetic)', () => {
		const module = `${GEO_SERVICES_DIR}geo_seams.ts`;
		const base = `export function ${GEO_SEAM_DOOR}(deps, work) { return work(); }\nexport function geoServiceSeams() { return {}; }\nexport type GeoServiceDeps = object;`;
		const toSeams = "'../../../src/core/geo_services/geo_seams.ts'";
		const tool = 'tools/tool_x/server/index.ts';
		const problems = (files: Record<string, string>): string[] =>
			geoSeamProblems(new Map([[module, base], ...Object.entries(files)]));

		// The sound shapes: the module's reader; a type; a tool that only calls the entry point.
		expect(problems({})).toEqual([]);
		expect(
			problems({
				[GEO_SERVICES_CALLER]:
					"import { geoServiceSeams } from './geo_seams.ts';\ngeoServiceSeams();",
			}),
		).toEqual([]);
		expect(
			problems({
				[`${GEO_SERVICES_DIR}t.ts`]: "import type { GeoServiceDeps } from './geo_seams.ts';",
			}),
		).toEqual([]);
		expect(
			problems({
				[tool]: `import { callGeoService } from '../../../src/core/geo_services/call.ts';\nawait callGeoService('dare_place', {});`,
			}),
		).toEqual([]);
		// A file that never names the seams module may load what it likes (the tool loader's case).
		expect(problems({ [tool]: 'const which = pick(); await import(which);' })).toEqual([]);

		const refused: Record<string, Record<string, string>> = {
			'a named import': {
				[tool]: `import { ${GEO_SEAM_DOOR} } from ${toSeams};\n${GEO_SEAM_DOOR}({}, () => 1);`,
			},
			'a renamed import': {
				[tool]: `import { ${GEO_SEAM_DOOR} as withSeams } from ${toSeams};\nwithSeams({}, () => 1);`,
			},
			'a namespace import (it can reach the opener)': {
				[tool]: `import * as seams from ${toSeams};\nseams.${GEO_SEAM_DOOR}({}, () => 1);`,
			},
			'a namespace used through a computed key': {
				[tool]: `import * as seams from ${toSeams};\nseams[pick()]({}, () => 1);`,
			},
			'a re-export': {
				[`${GEO_SERVICES_DIR}other.ts`]: `export { ${GEO_SEAM_DOOR} as withSeams } from './geo_seams.ts';`,
			},
			'a star re-export (a barrel inside the module)': {
				[`${GEO_SERVICES_DIR}index.ts`]: "export * from './geo_seams.ts';",
			},
			'a namespace re-export': {
				[`${GEO_SERVICES_DIR}other.ts`]: "export * as seams from './geo_seams.ts';",
			},
			'a tool importing that barrel': {
				[`${GEO_SERVICES_DIR}index.ts`]: "export * from './geo_seams.ts';",
				[tool]: `import { ${GEO_SEAM_DOOR} } from '../../../src/core/geo_services/index.ts';\n${GEO_SEAM_DOOR}({}, () => 1);`,
			},
			'a literal dynamic import': {
				[tool]: `export async function go() { return (await import(${toSeams})).${GEO_SEAM_DOOR}({}, () => 1); }`,
			},
			'a destructured dynamic import': {
				[tool]: `export async function go() { const { ${GEO_SEAM_DOOR}: run } = await import(${toSeams}); return run({}, () => 1); }`,
			},
			'require()': {
				[tool]: `const m = require(${toSeams});\nm.${GEO_SEAM_DOOR}({}, () => 1);`,
			},
			'import = require()': {
				[tool]: `import m = require(${toSeams});\nm.${GEO_SEAM_DOOR}({}, () => 1);`,
			},
			'a forwarder in the module that hands the opener on': {
				[`${GEO_SERVICES_DIR}other.ts`]: `import { ${GEO_SEAM_DOOR} } from './geo_seams.ts';\nexport function ask(deps, work) { return ${GEO_SEAM_DOOR}(deps, work); }`,
			},
			'a re-exported const alias': {
				[`${GEO_SERVICES_DIR}other.ts`]: `import { ${GEO_SEAM_DOOR} } from './geo_seams.ts';\nexport const withSeams = ${GEO_SEAM_DOOR};`,
			},
			'a non-literal load in a file that names the module': {
				[tool]: "const which = 'geo_seams';\nexport const go = () => import(`./${which}.ts`);",
			},
			'the opener’s name spelled with no binding': {
				[tool]: `const f = globalThis['${GEO_SEAM_DOOR}'];\nf({}, () => 1);`,
			},
		};
		for (const [what, files] of Object.entries(refused)) {
			expect(problems(files), what).not.toEqual([]);
		}
	});

	test('the entry point takes exactly (id, params): a third parameter, a rest, a destructured one or a missing one is refused (synthetic)', () => {
		const withParams = (declaration: string): string[] =>
			entryParameterProblems(
				GEO_SERVICES_CALLER,
				`export async function callGeoService${declaration} { return null; }`,
			);
		expect(withParams('(id: string, params: unknown = {})')).toEqual([]);
		expect(withParams('(id, params)')).toEqual([]);
		for (const bad of [
			'(id: string, params: unknown, deps: object = {})',
			'(id: string, params: unknown, ...rest: unknown[])',
			'(id: string, ...rest: unknown[])',
			'(id: string)',
			'()',
			'(id: string, { fetch }: { fetch: unknown })',
			'(params: unknown, id: string)',
		]) {
			expect(withParams(bad), bad).not.toEqual([]);
		}
		expect(entryParameterProblems(GEO_SERVICES_CALLER, 'export const x = 1;')).not.toEqual([]);
		expect(entryParameterProblems(GEO_SERVICES_CALLER, undefined)).toEqual([]);
	});
});
