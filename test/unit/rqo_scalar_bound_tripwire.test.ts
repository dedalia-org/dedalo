/**
 * RQO SCALAR BOUND TRIPWIRE — every string an unauthenticated or cheap-to-call
 * door can put into the engine declares a maximum (audit 2026-08-26 SEC-21).
 *
 * WHAT WENT WRONG. `rqoSchema` typed 54 scalars as a bare `z.string()` and the
 * `options` bag as `z.record(z.string(), z.unknown())`. `dd_utils_api` login
 * does `String(options.username ?? '')`, the body ceiling is 256 MiB and the
 * shipped nginx configs allow `client_max_body_size 300m`, so ONE unauthenticated
 * POST measured 67,109,061 bytes durably written to `matrix_activity` in 3.16 s.
 *
 * WHAT THIS GATE MEASURES — outcomes, never spellings:
 *
 *  1. TOTAL CENSUS, derived from the SCHEMA TREE ITSELF (not from the source
 *     text, which a rename or a helper would defeat): every `ZodString` leaf
 *     reachable from `rqoSchema` — through objects, unions, arrays, records,
 *     optionals and the recursive `z.lazy` SQO filter — must report a
 *     `maxLength`. A field declared with a helper counts; a field declared with
 *     a bare `z.string()` does not, whatever it is called.
 *  1b. A DOOR'S BOUND IS NEVER TIGHTER THAN THE BEHAVIOUR THE ENGINE SHIPS.
 *     TOTAL over the handler tree (dynamic import + source read, floor >15
 *     files, dd_identify_api and dd_mcp_api asserted reached): every exported
 *     numeric cap above the undeclared-remainder ceiling must have an `options`
 *     key the handler READS whose per-key budget is >= that cap. Charging only
 *     the keys already listed in `OPTIONS_KEY_BUDGETS` is what let
 *     `options.image` (dd_identify_api, 8 MiB photographs) be refused at 512 KiB
 *     with every gate green. Planted positive control: a synthetic 9 MB cap read
 *     from an unbudgeted key is flagged.
 *  2. The PARSE DOOR actually refuses: an oversize scalar and an oversize
 *     `options` bag are `false` from `rqoSchema.safeParse`, and an ordinary RQO
 *     still parses. This is the property that matters — the census only says
 *     WHY it holds.
 *  3. Every pre-auth action (derived from dispatch's `NO_LOGIN_ACTIONS`, never a
 *     hand list) is reached through that same door, so no unauthenticated caller
 *     has a path with looser bounds.
 *  4. Every shipped nginx config that proxies the API declares a request-rate
 *     ceiling — the hop in front of the engine, which costs the engine nothing.
 *  5. THE CENSUS DOES NOT STOP AT THE SCHEMA. A string that is in bounds at the
 *     door can still become durable bytes at ~2x if a downstream key is built by
 *     concatenating it: `login_attempts.attempt_key` (plus its index) is written
 *     twice per denial, and a 520 KB username — legal under the 512 KiB bag
 *     ceiling, since no real username earns a per-key declaration — measured
 *     2.08 MB of sqlite per unauthenticated denial. So this gate also measures
 *     the OUTCOME at the construction site: the throttle-key builders bound
 *     EVERY untrusted component — the identity AND the source, which is a
 *     caller-written X-Forwarded-For hop under a trusted-hop count >= 2 — and a
 *     flood of oversize denials on both axes leaves kilobytes rather than
 *     megabytes attributable to those keys.
 *
 * MUTATION-VERIFIED: removing `.max()` from one field, removing the options-bag
 * ceiling, and removing `limit_req` from one shipped config each turn a leg RED.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { NO_LOGIN_ACTIONS } from '../../src/core/api/dispatch.ts';
import { MAX_IMAGE_BASE64_CHARS } from '../../src/core/api/handlers/dd_identify_api.ts';
import {
	HISTORY_MAX_BYTES,
	IMAGES_MAX_TOTAL_BASE64_CHARS,
} from '../../src/core/api/handlers/dd_mcp_api.ts';
import { rqoSchema } from '../../src/core/concepts/rqo.ts';
import { OPTIONS_KEY_BUDGETS, SCALAR_BOUNDS } from '../../src/core/concepts/scalar_bounds.ts';
import {
	buildAccountThrottleKey,
	buildSourceThrottleKey,
	buildThrottleKey,
	clearAttempts,
	recordFailedAttempt,
	THROTTLE_IDENTITY_MAX_CHARS,
} from '../../src/core/security/session_store.ts';
import { DEPLOY_DIR, nginxConfNames } from '../helpers/deploy_artifact_corpus.ts';
import { apiHandlerFiles } from '../helpers/engine_source_corpus.ts';

/**
 * Fields that legitimately carry NO maximum, each with the reason. SHRINK-ONLY:
 * an entry may be removed when the field acquires a bound, never added without
 * a reason a reader can check.
 *
 * Empty today, and that is the point: every string in the request contract is
 * bounded. The list exists so the day one cannot be, the exemption is written
 * down rather than the census quietly widened.
 */
const UNBOUNDED_BY_DESIGN: Readonly<Record<string, string>> = {};

/**
 * THE HANDLER-CAP CENSUS (leg 1b), derived from the tree, never from a list.
 *
 * A handler that declares its own ceiling ABOVE the undeclared-remainder ceiling
 * is saying "I accept payloads this big"; if the key it reads them from has no
 * per-key budget, the parse door refuses them first and the door is dead. That
 * is exactly how `options.image` (dd_identify_api, 8 MiB photographs) was killed
 * while `options.images` (dd_mcp_api) was budgeted — the two look alike and only
 * a census over EVERY handler catches the next one.
 *
 * The pair is (exported numeric constants, source text) so the classifier can be
 * run over a PLANTED handler as a positive control.
 */
interface HandlerCap {
	/** The exported constant's name. */
	name: string;
	/** Its value, in characters/bytes of wire payload. */
	cap: number;
}

/** Every exported number in one handler above the undeclared-remainder ceiling. */
function capsAboveBagCeiling(exported: Record<string, unknown>): HandlerCap[] {
	return Object.entries(exported)
		.filter(([, value]) => typeof value === 'number' && value > SCALAR_BOUNDS.optionsBytes)
		.map(([name, value]) => ({ name, cap: value as number }));
}

/**
 * The `options` keys a handler source READS — `options.x`, `options?.x` and
 * `options['x']`. A read is what makes a key a door; a key nobody reads is not
 * one, whatever the schema says.
 */
function optionsKeysRead(source: string): Set<string> {
	const keys = new Set<string>();
	for (const match of source.matchAll(/\boptions\s*\??\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
		keys.add(match[1] as string);
	}
	for (const match of source.matchAll(/\boptions\s*\??\[\s*'([^']+)'/g)) {
		keys.add(match[1] as string);
	}
	return keys;
}

/**
 * The caps of ONE handler that no key it reads can actually carry: for each cap,
 * at least one read key must have a per-key budget >= that cap.
 */
function unbudgetedCaps(exported: Record<string, unknown>, source: string): string[] {
	const keys = optionsKeysRead(source);
	const budgets = [...keys].map((key) => OPTIONS_KEY_BUDGETS[key]?.bytes ?? 0);
	const widest = budgets.length === 0 ? 0 : Math.max(...budgets);
	return capsAboveBagCeiling(exported)
		.filter((entry) => entry.cap > widest)
		.map((entry) => `${entry.name} (${entry.cap})`);
}

interface StringLeaf {
	path: string;
	maxLength: number | null;
}

/**
 * Walk a zod schema and collect every string leaf with its path.
 *
 * Zod v4 exposes the shape through `def`; the walk handles every wrapper the
 * RQO actually uses and CARRIES A VISITED SET, because `sqoFilterNodeSchema` is
 * defined with `z.lazy` and refers to itself.
 */
function collectStringLeaves(schema: unknown, path: string, seen: Set<unknown>): StringLeaf[] {
	if (schema === null || typeof schema !== 'object') return [];
	if (seen.has(schema)) return [];
	seen.add(schema);
	const def = (schema as { def?: Record<string, unknown> }).def;
	if (def === undefined) return [];
	const type = def.type as string;
	switch (type) {
		case 'string':
			return [{ path, maxLength: (schema as { maxLength: number | null }).maxLength }];
		case 'object': {
			const shape = def.shape as Record<string, unknown>;
			const out: StringLeaf[] = [];
			for (const [key, child] of Object.entries(shape)) {
				out.push(...collectStringLeaves(child, `${path}.${key}`, seen));
			}
			if (def.catchall !== undefined) {
				out.push(...collectStringLeaves(def.catchall, `${path}.<catchall>`, seen));
			}
			return out;
		}
		case 'union':
			return (def.options as unknown[]).flatMap((option, index) =>
				collectStringLeaves(option, `${path}|${index}`, seen),
			);
		case 'array':
			return collectStringLeaves(def.element, `${path}[]`, seen);
		case 'record': {
			return [
				...collectStringLeaves(def.keyType, `${path}.<key>`, seen),
				...collectStringLeaves(def.valueType, `${path}.<value>`, seen),
			];
		}
		case 'optional':
		case 'nullable':
		case 'default':
		case 'catch':
		case 'readonly':
		case 'nonoptional':
			return collectStringLeaves(def.innerType, path, seen);
		case 'lazy': {
			const getter = def.getter as () => unknown;
			return collectStringLeaves(getter(), path, seen);
		}
		case 'pipe':
			// BOTH sides. A pipe's OUT is usually a transform (an opaque node), so
			// walking `out` alone made every schema behind a `.transform()` — the
			// whole ddo_map, for one — invisible to this census while the header
			// claimed it was covered.
			return [
				...collectStringLeaves(def.in, path, seen),
				...collectStringLeaves(def.out, path, seen),
			];
		default:
			return [];
	}
}

const leaves = collectStringLeaves(rqoSchema, 'rqo', new Set());

/** A valid, ordinary RQO — the control that must keep parsing. */
function ordinaryRqo(action = 'read'): Record<string, unknown> {
	return {
		action,
		dd_api: 'dd_core_api',
		source: {
			model: 'section',
			tipo: 'test1',
			section_tipo: 'test1',
			mode: 'list',
			lang: 'lg-eng',
		},
		sqo: { section_tipo: 'test1', limit: 10 },
		options: { username: 'curator' },
	};
}

describe('rqo scalar bound tripwire (audit 2026-08-26 SEC-21)', () => {
	test('the census actually reaches the schema (corpus floor)', () => {
		// The RQO + SQO + DDO schemas declared 55 string scalars when this gate was
		// written. A walk that silently stopped early (a wrapper type this switch
		// does not know) would report zero violations and prove nothing.
		expect(
			leaves.length,
			`only ${leaves.length} string leaves reached — the schema walk is not reaching the RQO tree`,
		).toBeGreaterThan(50);
		// It must reach the deep, recursive and record-keyed corners specifically.
		const paths = leaves.map((leaf) => leaf.path);
		expect(paths.some((path) => path.includes('.source.'))).toBe(true);
		expect(paths.some((path) => path.includes('.sqo.'))).toBe(true);
		expect(paths.some((path) => path.includes('.show.'))).toBe(true);
		expect(paths.some((path) => path.includes('<key>'))).toBe(true);
		// …INCLUDING the ddo_map, which sat behind a `.transform()` and was dark to
		// this census while the header claimed it was covered: every bound in
		// `ddoSchema` could be deleted and this gate stayed green.
		const ddoLeaves = paths.filter((path) => path.includes('ddo_map'));
		expect(
			ddoLeaves.length,
			`only ${ddoLeaves.length} ddo_map string leaves reached — the ddo contract is dark to the census`,
		).toBeGreaterThan(9);
		expect(ddoLeaves.some((path) => path.endsWith('.tipo'))).toBe(true);
	});

	test('every string scalar in the request contract declares a maximum', () => {
		const unbounded = leaves
			.filter((leaf) => leaf.maxLength === null || leaf.maxLength === undefined)
			.filter((leaf) => UNBOUNDED_BY_DESIGN[leaf.path] === undefined)
			.map((leaf) => leaf.path);
		expect(
			unbounded,
			`unbounded string scalar(s) in the RQO contract:\n  ${unbounded.join('\n  ')}\nDeclare a bound from src/core/concepts/scalar_bounds.ts, or add an entry to UNBOUNDED_BY_DESIGN with the reason.`,
		).toEqual([]);
	});

	test('POSITIVE CONTROL: the walk flags a planted unbounded string', () => {
		const planted = z
			.object({
				bounded: z.string().max(8),
				// The offender: exactly the shape the schema used to carry everywhere.
				offender: z.string().optional(),
				nested: z.object({ deep: z.array(z.string()) }),
			})
			.passthrough();
		const found = collectStringLeaves(planted, 'planted', new Set());
		const unbounded = found.filter((leaf) => leaf.maxLength === null).map((leaf) => leaf.path);
		expect(unbounded.sort()).toEqual(['planted.nested.deep[]', 'planted.offender']);
	});

	test('the parse door REFUSES an oversize scalar and an oversize options bag', () => {
		expect(rqoSchema.safeParse(ordinaryRqo()).success).toBe(true);

		const longTipo = ordinaryRqo();
		(longTipo.source as Record<string, unknown>).tipo = 'x'.repeat(SCALAR_BOUNDS.identifier + 1);
		expect(rqoSchema.safeParse(longTipo).success).toBe(false);

		// SEC-21 itself: the username rides in the untyped options bag, so no
		// per-field declaration can catch it — the BAG's ceiling must.
		const hugeUsername = ordinaryRqo();
		hugeUsername.options = { username: 'a'.repeat(SCALAR_BOUNDS.optionsBytes + 1) };
		expect(rqoSchema.safeParse(hugeUsername).success).toBe(false);

		// …and a bag with too many keys, which no byte ceiling would notice.
		const manyKeys = ordinaryRqo();
		const bag: Record<string, unknown> = {};
		for (let index = 0; index <= SCALAR_BOUNDS.optionsKeys; index += 1) bag[`k${index}`] = 1;
		manyKeys.options = bag;
		expect(rqoSchema.safeParse(manyKeys).success).toBe(false);

		// A REAL error report (tool_error_report send_report; 256 KiB is its own
		// documented ceiling) still fits.
		const realistic = ordinaryRqo('tool_request');
		realistic.options = { screenshot: `data:image/png;base64,${'A'.repeat(200 * 1024)}` };
		expect(rqoSchema.safeParse(realistic).success).toBe(true);
	});

	test('every pre-auth action passes through the same bounded door', () => {
		const preauth = [...NO_LOGIN_ACTIONS];
		expect(
			preauth.length,
			'NO_LOGIN_ACTIONS is empty — the pre-auth door set was not derived',
		).toBeGreaterThan(3);
		const leaked: string[] = [];
		for (const key of preauth) {
			// The registry keys are '<dd_api>.<action>'; the action is what the RQO
			// carries. An oversize options bag must be refused for EVERY one of them.
			const action = key.includes('.') ? (key.split('.').pop() as string) : key;
			const rqo = ordinaryRqo(action);
			rqo.options = { flood: 'a'.repeat(SCALAR_BOUNDS.optionsBytes + 1) };
			if (rqoSchema.safeParse(rqo).success) leaked.push(key);
		}
		expect(
			leaked,
			`pre-auth action(s) accepting an unbounded payload: ${leaked.join(', ')}`,
		).toEqual([]);
	});

	test('every shipped nginx config that proxies the API declares a rate ceiling', () => {
		const configs = nginxConfNames();
		// TOTAL over what deploy/ ships, with a floor: three configs existed when
		// this gate was written (reference, simple, simple-tls template).
		expect(
			configs.length,
			`only ${configs.length} nginx config(s) found in deploy/`,
		).toBeGreaterThan(2);
		const missing: string[] = [];
		for (const name of configs) {
			// COMMENTED-OUT is not DECLARED: a `#`-prefixed line is documentation,
			// and matching it would let the ceiling be disabled without a red gate.
			const text = readFileSync(join(DEPLOY_DIR, name), 'utf8')
				.split('\n')
				.filter((line) => !/^\s*#/.test(line))
				.join('\n');
			if (!text.includes('proxy_pass http://dedalo_ts')) continue;
			const declaresZone = /limit_req_zone\s+\$binary_remote_addr/.test(text);
			const usesZone = /\blimit_req\s+zone=/.test(text);
			if (!declaresZone || !usesZone) missing.push(name);
		}
		expect(
			missing,
			`shipped nginx config(s) proxying the API with no request-rate ceiling: ${missing.join(', ')}`,
		).toEqual([]);
	});

	test('EVERY handler cap above the bag ceiling has an options key that can carry it', async () => {
		// TOTAL over the handler tree: a per-key budget is not a list somebody
		// remembers to extend — every handler that declares a ceiling above the
		// undeclared remainder is measured against the keys it actually reads.
		// (`options.image` was missed exactly this way: dd_identify_api accepts
		// 8 MiB photographs and the parse door refused them at 512 KiB.)
		const files = apiHandlerFiles();
		expect(files.length, `only ${files.length} handler file(s) found`).toBeGreaterThan(15);
		const starved: string[] = [];
		const withCaps: string[] = [];
		for (const path of files) {
			const name = basename(path);
			const exported = (await import(path)) as Record<string, unknown>;
			if (capsAboveBagCeiling(exported).length > 0) withCaps.push(name);
			const missing = unbudgetedCaps(exported, readFileSync(path, 'utf8'));
			for (const entry of missing) starved.push(`${name}: ${entry}`);
		}
		// FLOOR + the two doors that must be reached, so an import that silently
		// stopped exporting cannot read as green.
		expect(withCaps, 'no handler cap found at all — the census reached nothing').not.toEqual([]);
		expect(withCaps).toContain('dd_identify_api.ts');
		expect(withCaps).toContain('dd_mcp_api.ts');
		expect(
			starved,
			`handler cap(s) the parse door refuses before the handler runs: ${starved.join(', ')}`,
		).toEqual([]);

		// POSITIVE CONTROL: the same classifier over a PLANTED handler — a 9 MB
		// cap read from an unbudgeted key is flagged, and budgeting the key it
		// reads clears it.
		expect(unbudgetedCaps({ SNAPSHOT_MAX_CHARS: 9_000_000 }, 'options?.snapshot')).toEqual([
			'SNAPSHOT_MAX_CHARS (9000000)',
		]);
		expect(unbudgetedCaps({ SNAPSHOT_MAX_CHARS: 9_000_000 }, 'options?.image')).toEqual([]);
	});

	test('a declared options key is never bounded below its own handler cap', () => {
		// The relation that matters, asserted against the HANDLER's own exported
		// constants rather than a copy of the numbers.
		expect(OPTIONS_KEY_BUDGETS.images?.bytes ?? 0).toBeGreaterThan(IMAGES_MAX_TOTAL_BASE64_CHARS);
		expect(OPTIONS_KEY_BUDGETS.history?.bytes ?? 0).toBeGreaterThan(HISTORY_MAX_BYTES);
		expect(OPTIONS_KEY_BUDGETS.image?.bytes ?? 0).toBeGreaterThan(MAX_IMAGE_BASE64_CHARS);
		for (const [key, budget] of Object.entries(OPTIONS_KEY_BUDGETS)) {
			expect(
				budget.reason.length,
				`${key}: a per-key budget needs a stated reason`,
			).toBeGreaterThan(40);
		}

		// OUTCOME, not arithmetic: a real ~750 KB photograph (1M base64 chars — 7x
		// under the per-image cap, 21x under the total) must reach the handler. A
		// flat 512 KiB bag ceiling refused it, killing image-based assistant chat
		// and object identification by photo.
		const withImage = ordinaryRqo('agent_chat');
		withImage.dd_api = 'dd_mcp_api';
		withImage.options = {
			question: 'what is this object?',
			images: [{ media_type: 'image/jpeg', data_base64: 'A'.repeat(1_000_000) }],
		};
		expect(rqoSchema.safeParse(withImage).success).toBe(true);

		// The budget is still a CEILING: past it the door refuses.
		const oversizeImage = ordinaryRqo('agent_chat');
		oversizeImage.dd_api = 'dd_mcp_api';
		oversizeImage.options = {
			question: 'q',
			images: [
				{
					media_type: 'image/jpeg',
					data_base64: 'A'.repeat((OPTIONS_KEY_BUDGETS.images?.bytes ?? 0) + 1),
				},
			],
		};
		expect(rqoSchema.safeParse(oversizeImage).success).toBe(false);

		// And the widening is PER KEY, never a hole in the bag: the same bytes
		// under an undeclared key are refused by the bag ceiling.
		const smuggled = ordinaryRqo('agent_chat');
		smuggled.options = { pictures: 'A'.repeat(SCALAR_BOUNDS.optionsBytes + 1) };
		expect(rqoSchema.safeParse(smuggled).success).toBe(false);

		// THE SECOND PHOTOGRAPH DOOR, as an outcome: object identification reads
		// `options.image` (SINGULAR) and accepts 8 MiB decoded, so a real ~750 KB
		// photograph must reach it — this parsed `false` until the key had a
		// budget, killing identify_by_image over HTTP while every gate stayed
		// green. Past the budget the door still refuses.
		const identify = ordinaryRqo('identify_by_image');
		identify.dd_api = 'dd_identify_api';
		identify.options = { image: 'A'.repeat(1_000_000) };
		expect(rqoSchema.safeParse(identify).success).toBe(true);
		const oversizeIdentify = ordinaryRqo('identify_by_image');
		oversizeIdentify.dd_api = 'dd_identify_api';
		oversizeIdentify.options = { image: 'A'.repeat((OPTIONS_KEY_BUDGETS.image?.bytes ?? 0) + 1) };
		expect(rqoSchema.safeParse(oversizeIdentify).success).toBe(false);
	});

	test('every untrusted component of a durable key is bounded where the key is BUILT', () => {
		// 520,000 chars: in bounds at the parse door (the undeclared-key remainder
		// ceiling is 512 KiB) and three orders of magnitude past any username.
		// The SOURCE axis is untrusted too — with TRUSTED_PROXY_HOPS >= 2 the hop
		// server.ts reads is caller-written, so its length is the caller's up to
		// Bun's header cap.
		const huge = 'U'.repeat(520_000);
		// The census of key builders that write to a durable store, swept on BOTH
		// argument positions: every exported builder whose key reaches
		// `login_attempts` (auth login on each axis, the source-global dimension,
		// the account dimension, and the password-reset doors, which share
		// buildThrottleKey).
		const keys = [
			buildThrottleKey('login', huge, '203.0.113.9'),
			buildThrottleKey('login', 'alice', huge),
			buildThrottleKey('login', huge, huge),
			buildSourceThrottleKey('login', huge),
			buildAccountThrottleKey('login', huge),
			buildThrottleKey('pwreset_req', huge, '203.0.113.9'),
			buildThrottleKey('pwreset_verify', huge, '203.0.113.9'),
			buildThrottleKey('error_report', '', huge),
		];
		expect(keys.length).toBeGreaterThan(7);
		for (const key of keys) {
			expect(key.length, `unbounded throttle key: ${key.length} chars`).toBeLessThanOrEqual(
				2 * THROTTLE_IDENTITY_MAX_CHARS + 128,
			);
		}

		// A bucket is only a bucket if it is STABLE and DISTINCT: the same inputs
		// must land in the same bucket every time (and case-insensitively, as
		// before), two different inputs must never share one — on EITHER axis.
		expect(buildThrottleKey('login', huge, huge)).toBe(buildThrottleKey('login', huge, huge));
		expect(buildThrottleKey('login', `${huge}A`, 'ip')).toBe(
			buildThrottleKey('login', `${huge}a`, 'ip'),
		);
		expect(buildThrottleKey('login', `${huge}a`, 'ip')).not.toBe(
			buildThrottleKey('login', `${huge}b`, 'ip'),
		);
		expect(buildThrottleKey('login', 'alice', `${huge}a`)).not.toBe(
			buildThrottleKey('login', 'alice', `${huge}b`),
		);
		expect(buildSourceThrottleKey('login', `${huge}a`)).not.toBe(
			buildSourceThrottleKey('login', `${huge}b`),
		);
		// A real username and a real address still read as themselves — the bound
		// is a ceiling, not a hash-everything.
		expect(buildThrottleKey('login', 'Alice', '10.0.0.1')).toBe('login|alice|10.0.0.1');
		expect(buildSourceThrottleKey('login', '203.0.113.9')).toBe('login|src|203.0.113.9');

		// THE OUTCOME, measured on the store itself and ATTRIBUTED TO THESE KEYS
		// (never the shared sqlite file's size, which any sibling gate's login
		// would charge to this leg): a flood of oversize denials on both axes must
		// not turn into megabytes on disk. Unbounded this is 40 x 520 KB, written
		// twice (row + index).
		const storePath = process.env.DEDALO_SESSION_DB_PATH;
		expect(typeof storePath, 'the bunfig preload must repoint the session store').toBe('string');
		const probeKeys = [
			buildThrottleKey('login', `${huge}_probe_${process.pid}`, '203.0.113.9'),
			buildThrottleKey('login', `probe_${process.pid}`, `${huge}_ip_${process.pid}`),
			buildSourceThrottleKey('login', `${huge}_src_${process.pid}`),
		];
		const reader = new Database(storePath as string, { readonly: true });
		const storedChars = (): number => {
			let total = 0;
			for (const key of probeKeys) {
				const row = reader
					.query(
						'SELECT COALESCE(SUM(LENGTH(attempt_key)), 0) AS chars FROM login_attempts WHERE attempt_key = ?',
					)
					.get(key) as { chars: number };
				total += Number(row.chars);
			}
			return total;
		};
		try {
			for (let i = 0; i < 20; i += 1) for (const key of probeKeys) recordFailedAttempt(key);
			expect(storedChars(), "the session store grew with the caller's bytes").toBeLessThan(
				256 * 1024,
			);
			// Not vacuous: the rows ARE there, so a zero would be a miscount.
			expect(storedChars()).toBeGreaterThan(0);
		} finally {
			reader.close();
			for (const key of probeKeys) clearAttempts(key);
		}
	});

	test('a client-supplied ddo_map is bounded in entries and in log lines', () => {
		const huge = ordinaryRqo();
		huge.show = {
			ddo_map: new Array(SCALAR_BOUNDS.ddoMapEntries + 1).fill({ tipo: 'test1' }),
		};
		expect(rqoSchema.safeParse(huge).success).toBe(false);

		// In bounds it still parses, and the per-entry resilience is intact: the
		// unusable entries are dropped, the usable ones survive.
		const mixed = ordinaryRqo();
		mixed.show = { ddo_map: [{ tipo: 'test1' }, {}, 'nonsense', { tipo: 'test2' }] };
		const parsed = rqoSchema.safeParse(mixed);
		expect(parsed.success).toBe(true);
		const kept = parsed.success
			? ((parsed.data as { show?: { ddo_map?: unknown[] } }).show?.ddo_map ?? [])
			: [];
		expect(kept.length).toBe(2);

		// The WARNING is bounded too — one log line per bad entry is an amplifier
		// the caller controls (the SEC-21 class, in the log instead of the DB).
		const originalWarn = console.warn;
		let lines = 0;
		console.warn = () => {
			lines += 1;
		};
		try {
			const noisy = ordinaryRqo();
			noisy.show = { ddo_map: new Array(200).fill({}) };
			expect(rqoSchema.safeParse(noisy).success).toBe(true);
		} finally {
			console.warn = originalWarn;
		}
		expect(lines).toBeLessThanOrEqual(SCALAR_BOUNDS.ddoMapWarnings + 1);
		expect(lines, 'the drop was silent — a narrowing nobody can see').toBeGreaterThan(0);
	});
});
