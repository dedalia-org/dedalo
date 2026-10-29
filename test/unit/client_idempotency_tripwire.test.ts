/**
 * CLIENT IDEMPOTENCY TRIPWIRE — a request the transport may RESEND must never
 * execute twice (CLI-01 / P0-10, WC-2026-08-28-idempotency-key).
 *
 * THE DEFECT THIS GATE EXISTS FOR. `data_manager.execute_request` shipped the
 * record write path with `retries:5 / timeout:5000`. `fetch_api` classifies its
 * OWN AbortController firing as `client.timeout`, which is retryable, and
 * re-sends the identical POST. The abort is CLIENT-SIDE ONLY — `src/server.ts`
 * has no `request.signal` handling anywhere — so the aborted attempt's handler
 * runs to completion and COMMITS. The resend was therefore a SECOND operation:
 * on a throttled link one click on "New record" produced up to five blank
 * records in the catalogue, and one click on "Duplicate" up to five clones of a
 * heritage record. Measured against the real transport with the shipped
 * defaults: 5 byte-identical POSTs over 47.5 s, and 78 s when the mid-attempt
 * health probe kept extending the deadline — so the busy-server probe is not a
 * mitigation, it is a window widener.
 *
 * WHAT IS PINNED, in seven blocks:
 *
 *  A. THE SERVER MAP IS TOTAL. `ACTION_IDEMPOTENCY` classifies every registered
 *     `(class, action)` pair — a newly registered action is red until it is
 *     classified. The `idempotent` half is additionally frozen as a CEILING:
 *     members may LEAVE it (that is more protection), and adding one is a
 *     deliberate, reviewable diff, because an action wrongly called idempotent
 *     is an action whose duplicate execution nobody stops.
 *
 *  B. THE WIRE. `idempotency_key` is declared on the rqo with the same grammar
 *     the client mints against, so a malformed key is ONE uniform refusal at the
 *     parse door. And `prevent_lock` — the field the finding named as "accepted
 *     with no implementation behind it" — is held INERT mechanically: this gate
 *     asserts its declaration is its ONLY mention in `src/` and `tools/`, so it
 *     can never quietly acquire behaviour behind its own docblock.
 *
 *  C. THE CLIENT CENSUS IS TOTAL over every `data_manager.request` /
 *     `request_stream` / `request_fetch_stream` call site in `client/` and
 *     `tools/**\/js` — AND over every browser file that reaches the API by any
 *     other transport: importing `api_transport.js`, `navigator.sendBeacon`, a
 *     raw `fetch()` aimed at the API, or `new XMLHttpRequest`. The last two are
 *     the hole the first draft of this census had, and four files fall in it.
 *     Each exemption declares the BASIS on which its resend is harmless
 *     (idempotent actions / single-shot / not gated here at all) and the gate
 *     checks that basis rather than taking the word for it.
 *
 *  D. THE CLIENT BEHAVES. The REAL `data_manager.js` is imported (its own bytes,
 *     unmodified — only its leaf modules are stubbed) and driven against a
 *     stalling server: all attempts of one call carry ONE key, byte-identical;
 *     a `retries:1` call carries none; a body that CANNOT be stamped is sent at
 *     most once; and a bodyless GET still retries, because CLI-01 is about
 *     stopping duplicate EXECUTION, not about stopping retrying.
 *
 *  E. THE SERVER HONOURS IT — driven through the REAL door, `dispatchRqo` with
 *     `dd_core_api:create` on the generic `test` TLD, with the POSITIVE CONTROLS
 *     that make the rest mean anything: two DIFFERENT keys still make two
 *     records, and NO key still makes two records (i.e. the defect is real and
 *     this gate can see it). And THE AMBIGUOUS-OUTCOME RULE: a probe that WRITES
 *     a record and THEN throws must not re-execute on the retry — it is refused
 *     with `idempotency.outcome_unknown`, while a NEW key for the same work
 *     still executes, so nothing lawful is locked out.
 *
 *  F. THE LEDGER IS BOUNDED, and each bound is TRIPPED here rather than
 *     asserted: age eviction (both from the sweeper AND on the read path, with
 *     the clock moved past the TTL), the per-principal entry and byte caps
 *     driven through a real leader completion, the process-wide backstop, byte
 *     accounting that returns to zero, and an in-flight entry that eviction must
 *     never take.
 *
 *  G. A TWIN NEVER WAITS FOREVER. The bounded wait is exercised twice: the
 *     mechanism at a millisecond deadline, and the WIRING — a real twin of a
 *     really stuck leader, refused at the real production bound with
 *     `idempotency.in_progress` while the leader itself finishes untouched.
 *
 * HONEST LIMITS. (1) The residual window is real and is not gated because it
 * cannot be: the ledger is in-process, so a process restart between the commit
 * and the retry, or a multi-process deployment, re-admits one duplicate. The
 * durable form writes the key inside the write's own transaction and needs the
 * handler doors, not this chokepoint. (2) The process-wide entry/byte backstop
 * is NOT per-principal: one operator cannot evict another's entries by their own
 * volume (block F proves that), but tens of simultaneously active operators
 * together can reach the backstop, and there eviction is oldest-first across
 * principals. Stated, not gated away. (3) The MULTIPART upload branch in
 * `src/server.ts` answers before `dispatchRqo` and is therefore not behind this
 * gate at all — block C pins that branch's shape so the claim cannot rot, and
 * the exemption names what bounds it instead (`transfer_id`, minted once per
 * transfer). (4) The client census reads `retries` as a literal; a site passing a
 * variable must be enumerated below (none since 2026-10-12, when the installer
 * helper that did left with the browser wizard). (5) The census
 * scope is client code BY DIRECTORY — browser JS served from outside `client/`
 * and `tools/**\/js` would escape it, the same gap
 * `client_error_contract_tripwire` names in its own header.
 *
 * TIER: DB. Blocks A-D run without Postgres, but blocks E, F and G drive the
 * real create door, so the file as a whole belongs to the DB tier.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	ACTION_IDEMPOTENCY,
	actionTableFor,
	awaitLeaderBounded,
	dispatchRqo,
	idempotencyLedgerKey,
	idempotencyLedgerStats,
	listRegisteredActions,
	NO_LOGIN_ACTIONS,
	resetIdempotencyLedgerForTests,
	seedIdempotencyLedgerForTests,
	sweepIdempotencyLedgerForTests,
} from '../../src/core/api/dispatch.ts';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import type { ApiResult } from '../../src/core/api/response.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { rqoSchema } from '../../src/core/concepts/rqo.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { ok } from '../../src/core/errors/convert.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';
import { stripComments } from '../helpers/strip_comments.ts';

registerSessionCleanup();

const REPO_ROOT = join(import.meta.dir, '..', '..');

// ---------------------------------------------------------------------------
// A — the server map is TOTAL over the registry, and `idempotent` is a ceiling
// ---------------------------------------------------------------------------

/**
 * THE FROZEN CEILING. Every pair the map may call `idempotent`. A pair may drop
 * OUT of the map's idempotent half without touching this list (that only adds
 * protection); adding one that is not here is red, because "this action is safe
 * to execute twice" is the one claim in this whole change set that, if wrong,
 * silently re-admits the defect.
 */
const IDEMPOTENT_CEILING: ReadonlySet<string> = new Set([
	'dd_core_api:read',
	'dd_core_api:read_raw',
	'dd_core_api:count',
	'dd_core_api:start',
	'dd_core_api:get_element_context',
	'dd_core_api:get_section_elements_context',
	'dd_core_api:get_section_terms',
	'dd_core_api:get_indexation_grid',
	'dd_core_api:get_activity_metric',
	'dd_core_api:get_ip_country',
	'dd_core_api:get_environment',
	'dd_tools_api:user_tools',
	'dd_diffusion_api:count_pending_deletions', // a COUNT: executing it twice changes nothing
	'dd_diffusion_api:follow_queue',
	'dd_diffusion_api:get_process_status',
	'dd_diffusion_api:get_diffusion_info',
	'dd_diffusion_api:get_engine_advisory',
	'dd_diffusion_api:list_processes',
	'dd_diffusion_api:validate',
	'dd_component_text_area_api:get_tags_info',
	'dd_component_av_api:get_media_streams',
	'dd_component_info:get_widget_data',
	'dd_ts_api:get_node_data',
	'dd_ts_api:get_children_data',
	'dd_utils_api:update_lock_components_state',
	'dd_utils_api:get_lock_status',
	'dd_utils_api:get_activity',
	'dd_utils_api:get_record_jobs',
	'dd_utils_api:get_record_info', // pure read: the inspector's created / modified / published stamps
	'dd_utils_api:get_job_events',
	'dd_utils_api:get_process_status',
	'dd_utils_api:get_system_info',
	'dd_utils_api:get_login_context',
	'dd_utils_api:get_dedalo_files',
	'dd_utils_api:list_uploaded_files',
	'dd_utils_api:convert_search_object_to_sql_query',
	'dd_utils_api:get_server_ready_status',
	'dd_utils_api:get_ontology_update_info',
	'dd_utils_api:get_code_update_info',
	'dd_rag_api:retrieve',
	'dd_rag_api:semantic_search',
	'dd_rag_api:search_by_text_image',
	'dd_rag_api:similar_objects',
	'dd_rag_api:similar_to',
	'dd_rag_api:embed_groups',
	'dd_rag_api:get_agent_context',
	'dd_identify_api:find_matches',
	'dd_identify_api:get_proposals',
	'dd_identify_api:resolve_type_link',
	'dd_external_api:search',
	'dd_mcp_api:agent_models',
]);

describe('A — the action → idempotency map', () => {
	const registered = listRegisteredActions().map((p) => `${p.apiClass}:${p.action}`);

	test('anti-vacuity floor: the registry is populous and the map covers it', () => {
		expect(registered.length).toBeGreaterThan(85);
		expect(ACTION_IDEMPOTENCY.size).toBe(registered.length);
	});

	test('TOTAL: every registered (class, action) pair is classified', () => {
		const unclassified = registered.filter((key) => !ACTION_IDEMPOTENCY.has(key)).sort();
		expect(
			unclassified,
			'A newly registered action is UNCLASSIFIED. Classify it in ACTION_IDEMPOTENCY (src/core/api/dispatch.ts). `mutating` is the fail-safe answer and costs only a ledger entry.',
		).toEqual([]);
	});

	test('the map carries no stale entry for an action that no longer exists', () => {
		const known = new Set(registered);
		const stale = [...ACTION_IDEMPOTENCY.keys()].filter((key) => !known.has(key)).sort();
		expect(stale).toEqual([]);
	});

	test('`idempotent` never grows past the frozen ceiling', () => {
		const idempotent = [...ACTION_IDEMPOTENCY.entries()]
			.filter(([, kind]) => kind === 'idempotent')
			.map(([key]) => key);
		const beyond = idempotent.filter((key) => !IDEMPOTENT_CEILING.has(key)).sort();
		expect(
			beyond,
			'An action was newly declared idempotent. That REMOVES duplicate-execution protection from it — justify it and add it to IDEMPOTENT_CEILING in the same commit.',
		).toEqual([]);
		// and the ceiling stays honest: no entry for a pair that is not (or is no
		// longer) classified idempotent.
		const stale = [...IDEMPOTENT_CEILING].filter((key) => !idempotent.includes(key)).sort();
		expect(stale).toEqual([]);
	});

	test('the record-lifecycle doors the finding named are `mutating`', () => {
		for (const key of [
			'dd_core_api:create',
			'dd_core_api:duplicate',
			'dd_core_api:save',
			'dd_core_api:delete',
			'dd_ts_api:add_child',
			'dd_tools_api:tool_request',
			'dd_area_maintenance_api:widget_request',
			'dd_mcp_api:agent_apply',
		]) {
			expect(ACTION_IDEMPOTENCY.get(key), key).toBe('mutating');
		}
	});
});

// ---------------------------------------------------------------------------
// B — the wire: the key's grammar, and prevent_lock held inert
// ---------------------------------------------------------------------------

describe('B — the wire contract', () => {
	const base = { action: 'read', dd_api: 'dd_core_api' };

	test('a well-formed key parses; a malformed one is refused at the parse door', () => {
		expect(rqoSchema.safeParse({ ...base, idempotency_key: 'a'.repeat(32) }).success).toBe(true);
		expect(rqoSchema.safeParse({ ...base, idempotency_key: crypto.randomUUID() }).success).toBe(
			true,
		);
		// too short, too long, and out of the URL-safe alphabet
		expect(rqoSchema.safeParse({ ...base, idempotency_key: 'short' }).success).toBe(false);
		expect(rqoSchema.safeParse({ ...base, idempotency_key: 'a'.repeat(129) }).success).toBe(false);
		expect(rqoSchema.safeParse({ ...base, idempotency_key: `${'a'.repeat(20)} b` }).success).toBe(
			false,
		);
		// and a request without one is still lawful — the stamp is the transport's
		// duty, never every client author's.
		expect(rqoSchema.safeParse(base).success).toBe(true);
	});

	test('the client mints against the SAME grammar the schema enforces', () => {
		const client = readFileSync(
			join(REPO_ROOT, 'client/dedalo/core/common/js/data_manager.js'),
			'utf8',
		);
		const schema = readFileSync(join(REPO_ROOT, 'src/core/concepts/rqo.ts'), 'utf8');
		const grammar = '[A-Za-z0-9_-]{16,128}';
		expect(client).toContain(grammar);
		expect(schema).toContain(grammar);
	});

	test('`prevent_lock` has ZERO readers — it is written and never consulted', () => {
		// A READ is any mention that is not an object-literal KEY (`prevent_lock:`)
		// — a property access, a destructure, a conditional. The schema declaration
		// is itself a key, so the whole file set below is writes-only by shape.
		const readers: string[] = [];
		const mentions: string[] = [];
		for (const dir of ['src', 'tools']) {
			const glob = new Bun.Glob('**/*.ts');
			for (const rel of glob.scanSync(join(REPO_ROOT, dir))) {
				if (rel.endsWith('.test.ts')) continue;
				const file = `${dir}/${rel}`;
				const source = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
				const found = [...source.matchAll(/prevent_lock(\s*)(.?)/g)];
				if (found.length === 0) continue;
				mentions.push(file);
				if (found.some((hit) => hit[2] !== ':')) readers.push(file);
			}
		}
		expect(
			readers.sort(),
			'`prevent_lock` acquired a READER. It is a retired PHP fossil (session_write_close, no Bun equivalent), declared in the rqo schema ONLY so ~20 client sites do not 400. Request-level de-duplication is `idempotency_key`; the component EDIT locks are section/locks.ts.',
		).toEqual([]);
		// ENUMERATED, shrink-only: everything that so much as names the field.
		//
		// THE TWO INTERNAL SENDERS, SETTLED (2026-08-28). src/ai/mcp/tools/
		// records_read.ts and src/core/ontology/data_io_import.ts both build an rqo
		// IN-PROCESS and set `prevent_lock: true` on it. ONE OF THEM DOES CROSS THE
		// WIRE: data_io_import.ts POSTs its rqo to a REMOTE master
		// (checkRemoteServer), so the inert field travels between installations.
		// records_read.ts is in-process only. Nothing READS the flag at either end
		// both are pure cargo-cult: they carry a PHP session-runtime flag into a
		// runtime that has no PHP sessions. They are held here rather than deleted
		// because deletion touches two files outside this change's scope — the
		// SHRINK-ONLY shape of this list is what makes that a scheduled removal and
		// not an omission: dropping either sender is a one-line diff plus one line
		// here, and this expectation fails the day someone adds a third.
		//
		// The DECLARATION in rqo.ts stays until no shipped client sends the field:
		// removing it would make `.passthrough()` absorb it silently, which is
		// worse than an accepted field whose inertness is gated.
		expect(mentions.sort()).toEqual([
			'src/ai/mcp/tools/records_read.ts',
			'src/core/concepts/rqo.ts',
			'src/core/ontology/data_io_import.ts',
		]);
	});
});

// ---------------------------------------------------------------------------
// C — the client census (TOTAL) and the enumerated bypass exemptions
// ---------------------------------------------------------------------------

/** Every tracked browser `.js` under the two client roots. */
function clientJsFiles(): string[] {
	const listed = Bun.spawnSync(['git', 'ls-files', '*.js'], { cwd: REPO_ROOT }).stdout.toString();
	return listed
		.split('\n')
		.filter(
			(file) =>
				file !== '' &&
				(file.startsWith('client/') ||
					/^tools\/[^/]+\/js\//.test(file) ||
					/^tools\/[^/]+\/.*\/js\//.test(file)),
		)
		.sort();
}

/** The argument-object text of a call whose `(` is at `open`. */
function callArgument(source: string, open: number): string | null {
	let depth = 0;
	for (let index = open; index < source.length; index++) {
		const char = source[index] as string;
		if (char === '(' || char === '{' || char === '[') depth++;
		else if (char === ')' || char === '}' || char === ']') {
			depth--;
			if (depth === 0) return source.slice(open + 1, index);
		}
	}
	return null;
}

interface CallSite {
	file: string;
	line: number;
	call: string;
	retries: string | null;
	setsKey: boolean;
}

/**
 * A call site, whatever the line breaks: a formatter splits a long call into
 * `data_manager` / `.request_stream({` on two lines (biome does, 2026-10-07 on
 * the acquisition tools), and a dot-adjacent pattern then reads NOTHING there —
 * the site leaves the census silently. Whitespace is allowed around the dot.
 */
const CALL_SITE_PATTERN = /data_manager\s*\.\s*(request|request_stream|request_fetch_stream)\s*\(/g;

function censusCallSites(): CallSite[] {
	const pattern = new RegExp(CALL_SITE_PATTERN.source, 'g');
	const sites: CallSite[] = [];
	for (const file of clientJsFiles()) {
		const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
		if (!raw.includes('data_manager')) continue;
		const source = stripComments(raw);
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null = pattern.exec(source);
		while (match !== null) {
			const open = match.index + match[0].length - 1;
			const argument = callArgument(source, open) ?? '';
			sites.push({
				file,
				line: source.slice(0, match.index).split('\n').length,
				call: match[1] as string,
				retries: argument.match(/\bretries\s*:\s*([^,\n}]+)/)?.[1]?.trim() ?? null,
				setsKey: /\bidempotency_key\s*:/.test(argument),
			});
			match = pattern.exec(source);
		}
	}
	return sites;
}

/**
 * THE ENUMERATED, SHRINK-ONLY EXEMPTION LIST: browser code that reaches the API
 * WITHOUT `data_manager.request`, and therefore without its stamp.
 *
 * THE FIRST DRAFT OF THIS CENSUS HAD A BYPASS HOLE, which is why `basis` exists.
 * It detected only `data_manager.request` call sites and files importing
 * `api_transport.js`, so a raw `fetch()` or a `new XMLHttpRequest` aimed straight
 * at the API was invisible to it — and four of those exist. Three of the four
 * send `mutating` actions, so the old rule ("every action an exempt transport
 * can send must be classified idempotent") could not have covered them: it would
 * have been red, or, worse, quietly true because they were never seen.
 *
 * Each entry now declares WHY it is safe, and the gate checks that basis:
 *
 *   - `stamper`            — data_manager itself. Not a bypass, the door.
 *   - `idempotent-actions` — it may resend, but every action it can send is
 *                            classified `idempotent`, so a resend duplicates
 *                            nothing. The gate checks each named action.
 *   - `single-shot`        — it issues ONE request and has no retry loop of its
 *                            own, so it cannot produce the resend CLI-01 is
 *                            about. Its actions may therefore be `mutating`.
 *                            The gate checks, mechanically, that the file asks
 *                            the transport for no resend either (every `retries`
 *                            literal in it is 1) and that it does not import
 *                            api_transport.js.
 *   - `not-gated-here`     — it reaches a door that is NOT behind Gate 4 at all.
 *                            Exactly one exists (the multipart upload branch),
 *                            and the gate pins that branch's shape in server.ts
 *                            so this claim cannot go stale silently.
 *   - `harness`            — client test code, no operator surface.
 *
 * THE SAME LIST IS THE CENSUS OF THE PAGE-IDENTITY LATCH (LEAD-2): every one of
 * these files opens a connection to the API on its own, so each one either ASKS
 * `refused_by_page_identity` (error_dispatch.js) before it sends —
 * `identity_latch: 'asks'`, checked below against the file's code — or says why
 * a revoked page identity has nothing to lose there. data_manager.js asks for
 * every `data_manager.request` / stream call site in the client; this list
 * holds the rest, so a new raw door cannot ship without answering it.
 */
const TRANSPORT_BYPASS_EXEMPTIONS: ReadonlyArray<{
	file: string;
	basis: 'stamper' | 'idempotent-actions' | 'single-shot' | 'not-gated-here' | 'harness';
	actions: readonly string[];
	reason: string;
	/**
	 * `'asks'` — the file calls refused_by_page_identity before it sends;
	 * `{exempt}` — a SAFE basis: why a revoked page has nothing to lose there;
	 * `{open_gap}` — an admitted hole. It exists so a known hole can be WRITTEN
	 * DOWN, never so it can sit green: any `open_gap` entry fails the gate.
	 */
	identity_latch: 'asks' | { exempt: string } | { open_gap: string };
}> = [
	{
		file: 'client/dedalo/core/common/js/data_manager.js',
		basis: 'stamper',
		actions: [],
		reason:
			'THE stamper itself — it owns fetch_api and is where the key is minted. Not a bypass, the door.',
		identity_latch: 'asks',
	},
	{
		file: 'client/dedalo/core/service_worker.js',
		basis: 'idempotent-actions',
		actions: ['dd_utils_api:get_dedalo_files'],
		reason:
			'The service worker calls fetch_api directly (retries:3) from a context that has no page and no CSRF token. ONE read action, classified idempotent.',
		identity_latch: {
			exempt:
				'A Service Worker realm: it cannot see the page latch (page state), and it sends one READ (get_dedalo_files, the static file list) that carries no record state of the page.',
		},
	},
	{
		file: 'client/dedalo/core/page/js/worker_cache.js',
		basis: 'idempotent-actions',
		actions: ['dd_utils_api:get_dedalo_files'],
		reason:
			'The cache Worker, same single read action and the same reasoning as service_worker.js.',
		identity_latch: {
			exempt:
				'A dedicated Worker realm, same single READ (get_dedalo_files) and the same reasoning as service_worker.js: no page state rides it.',
		},
	},
	{
		file: 'client/dedalo/core/page/js/page.js',
		basis: 'idempotent-actions',
		actions: ['dd_utils_api:update_lock_components_state'],
		reason:
			'navigator.sendBeacon on beforeunload releases the component lock; a beacon cannot set headers (the CSRF token rides in the body) and the browser never retries it. The action is a verified-idempotent upsert.',
		// the beforeunload beacon (send_lock_release_beacon): the server runs
		// delete_user_section_locks as the SESSION's user, so on a revoked page it
		// would release the NEW user's live locks; refused, A's lock expires by TTL
		identity_latch: 'asks',
	},
	{
		file: 'tools/tool_assistant/js/agent_stream.js',
		basis: 'single-shot',
		actions: ['dd_mcp_api:agent_chat_stream'],
		reason:
			'ONE raw fetch(data_manager.url) opening an SSE turn, because the stamping transport cannot hand back a ReadableStream. No retry loop, no deadline of its own: an abort is the user pressing stop, and the caller renders it rather than re-sending. The action is `mutating` (each attempt is a separate model run) and that is exactly why it must never be resent blind.',
		identity_latch: 'asks',
	},
	{
		file: 'tools/tool_sitebuilder/js/builder_stream.js',
		basis: 'single-shot',
		actions: ['dd_tools_api:tool_request'],
		reason:
			'ONE raw fetch(data_manager.url) opening the site-builder session SSE stream (source model tool_sitebuilder, action session_stream). Same shape and same reasoning as agent_stream.js: no retry loop, so no resend to de-duplicate.',
		identity_latch: 'asks',
	},
	{
		file: 'tools/tool_transcription/js/tool_transcription.js',
		basis: 'single-shot',
		actions: ['dd_tools_api:tool_request'],
		reason:
			'ONE keepalive fetch on window unload, deleting the throwaway server-side WAV (tool_request → delete_transcribable_audio_file). data_manager cannot be trusted during unload, and keepalive is the one shape the browser promises to finish after the page is gone. The browser does not retry it, and every `retries` in this file is 1.',
		identity_latch: 'asks',
	},
	{
		file: 'client/dedalo/core/services/service_upload/js/upload_transport.js',
		basis: 'not-gated-here',
		actions: ['dd_utils_api:join_chunked_files_uploaded'],
		reason:
			'THE ONE CLIENT TRANSPORT THAT ALREADY RETRIES BY ITSELF (max_retry 3 per chunk), and its chunk POSTs are multipart/form-data — answered by the multipart branch in src/server.ts, which returns BEFORE dispatchRqo and therefore never reaches Gate 4. What bounds it there is its own per-transfer identity: transfer_id is minted ONCE per transfer and every retried chunk carries the same one, so a resent chunk lands in the same staging artifact instead of a second one. The step that turns staged chunks into a record, join_chunked_files_uploaded, comes back through the JSON door with retries:5 and IS stamped and gated.',
		identity_latch: 'asks',
	},
	{
		file: 'client/dedalo/test/client/js/test_api_error.js',
		basis: 'harness',
		actions: [],
		reason:
			'The CLIENT TEST HARNESS drives fetch_api deliberately, to exercise the error contract. It ships under client/dedalo/test/ and no operator surface reaches it.',
		identity_latch: {
			exempt: 'The client test harness: no page identity and no operator surface.',
		},
	},
];

/**
 * Every browser file that reaches the API WITHOUT data_manager.request, by any
 * of the four transports there are: importing the retrying `api_transport.js`
 * directly, `navigator.sendBeacon`, a raw `fetch()` whose target is the API, or
 * `new XMLHttpRequest`. The last two are the bypasses the first draft could not
 * see. A raw fetch at a MEDIA url or at `/health` is not an API transport and is
 * deliberately not matched — the API targets are the three spellings the client
 * has for this server's JSON door.
 */
function apiBypassingFiles(): string[] {
	const API_TARGET = /data_manager\.url|DEDALO_API_URL|api\/v1\/json/;
	const bypassing: string[] = [];
	for (const file of clientJsFiles()) {
		const source = stripComments(readFileSync(join(REPO_ROOT, file), 'utf8'));
		const rawFetchAtApi = [...source.matchAll(/fetch\s*\(\s*([^,)]{0,120})/g)].some((hit) =>
			API_TARGET.test(hit[1] as string),
		);
		if (
			/from\s+'[^']*api_transport\.js'/.test(source) ||
			/sendBeacon\s*\(/.test(source) ||
			/new\s+XMLHttpRequest/.test(source) ||
			rawFetchAtApi
		) {
			bypassing.push(file);
		}
	}
	return bypassing.sort();
}

/**
 * The page-identity half of the census, as a function of the entries so the
 * gate can prove on a synthetic entry that an admitted hole (`open_gap`) is red.
 */
function identityLatchOffenders(
	entries: ReadonlyArray<(typeof TRANSPORT_BYPASS_EXEMPTIONS)[number]>,
): string[] {
	const offenders: string[] = [];
	for (const entry of entries) {
		const source = stripComments(readFileSync(join(REPO_ROOT, entry.file), 'utf8'));
		const asks = /\brefused_by_page_identity\s*\(/.test(source);
		const latch = entry.identity_latch;
		if (latch === 'asks') {
			if (!asks) {
				offenders.push(`${entry.file}: declared 'asks' but never calls refused_by_page_identity`);
			}
			continue;
		}
		if ('open_gap' in latch) {
			// an admitted hole is written down, and it is RED until it is closed
			offenders.push(`${entry.file}: OPEN GAP — ${latch.open_gap}`);
			continue;
		}
		expect(latch.exempt.length, entry.file).toBeGreaterThan(40);
		// a stale exemption: the file asks now, so the entry must say so
		if (asks) offenders.push(`${entry.file}: asks the latch but is listed as exempt`);
	}
	return offenders;
}

describe('C — the client census (TOTAL over client/ and tools/**/js)', () => {
	const sites = censusCallSites();
	const requests = sites.filter((site) => site.call === 'request');

	test('the call-site matcher reads a formatter-split chain (positive control)', () => {
		const split = 'data_manager\n\t\t\t\t.request_stream({ body: {} })';
		const flat = 'data_manager.request({ body: {} })';
		expect([...split.matchAll(new RegExp(CALL_SITE_PATTERN.source, 'g'))].map((m) => m[1])).toEqual(
			['request_stream'],
		);
		expect([...flat.matchAll(new RegExp(CALL_SITE_PATTERN.source, 'g'))].map((m) => m[1])).toEqual([
			'request',
		]);
	});

	test('anti-vacuity: the census actually found the population', () => {
		// Measured 2026-08-28 on branch v7: 246 call sites, 228 through the
		// RETRYING transport and 18 through the two streaming doors (raw fetch, no
		// retry loop, no deadline — a `retries` option there is inert).
		// 2026-09-24: 18 → 17 streaming sites. The ONE that left is
		// tool_export.js's `data_manager.request_fetch_stream` (the browser-side
		// NDJSON export): the export is now server-built (build_export_artifact,
		// a background job followed through job_follow's request_stream, which
		// was already counted), so the population genuinely shrank — the tool's
		// remaining calls are data_manager.request sites with LITERAL retries.
		// 2026-10-07: 17 → 19 streaming sites. The TWO that arrived are the two
		// TS-native acquisition tools' job followers —
		// render_tool_numisdata_acquisition.js and
		// render_tool_bibliography_acquisition.js, each a `request_stream` on
		// dd_utils_api get_process_status for its own background job (the same
		// read-only follow shape as tool_import_files / tool_update_cache), so the
		// population genuinely grew.
		// 2026-10-12: 19 → 20 streaming sites. The ONE that arrived is
		// client/dedalo/test/client/js/test_relogin_identity.js's
		// `data_manager.request_fetch_stream({body: write_body()})` (67dc84bb34,
		// the re-login identity latch suite: its unlatched control proves the
		// fetch-stream door still sends before the latch). The census scope is
		// all of client/, browser-suite files included (test_error_stream.js was
		// already counted), so the population genuinely grew; no production
		// streaming site was added.
		expect(sites.length).toBeGreaterThanOrEqual(240);
		expect(requests.length).toBeGreaterThanOrEqual(220);
		expect(sites.length - requests.length).toBe(20);
		// the finding's own headline sites are in the corpus, at the default
		expect(
			requests.some((s) => s.file.endsWith('section/js/section.js') && s.retries === null),
		).toBe(true);
		expect(
			requests.some(
				(s) => s.file.endsWith('component_common/js/component_common.js') && s.retries === null,
			),
		).toBe(true);
	});

	test('no call site mints its own key — the transport owns it', () => {
		const offenders = sites
			.filter((site) => site.setsKey)
			.map((site) => `${site.file}:${site.line}`);
		expect(
			offenders,
			'A caller passing its own idempotency_key can reuse one across two DIFFERENT operations, which silently swallows the second. data_manager mints one per call.',
		).toEqual([]);
	});

	test("every site's `retries` is a literal, or is an ENUMERATED dynamic one", () => {
		const dynamic = requests
			.filter(
				(site) =>
					site.retries !== null && !/^\d+(\s*\*\s*\d+)*$/.test(site.retries.replace(/_/g, '')),
			)
			.map((site) => `${site.file}:${site.line}`)
			.sort();
		expect(
			dynamic,
			'A call site whose retries value the census cannot read. Enumerate it here with a reason, or make it a literal.',
		).toEqual([]);
	});

	test('the transports that bypass data_manager.request are exactly the enumerated ones', () => {
		expect(
			apiBypassingFiles(),
			'A browser transport reaches the API without the idempotency stamp. Route it through data_manager.request, or add it to TRANSPORT_BYPASS_EXEMPTIONS with the actions it sends AND the basis on which a resend of those is harmless.',
		).toEqual(TRANSPORT_BYPASS_EXEMPTIONS.map((entry) => entry.file).sort());
	});

	test('anti-vacuity: the raw-transport half of the detector actually fires', () => {
		// The first draft saw only data_manager.request and api_transport imports.
		// These four are the ones it could not see — three of them sending
		// `mutating` actions. If the detector ever stops finding them it has gone
		// blind again, and this assertion is what says so.
		const found = apiBypassingFiles();
		for (const file of [
			'tools/tool_assistant/js/agent_stream.js',
			'tools/tool_sitebuilder/js/builder_stream.js',
			'tools/tool_transcription/js/tool_transcription.js',
			'client/dedalo/core/services/service_upload/js/upload_transport.js',
		]) {
			expect(found, `${file} must be seen by the raw fetch/XHR detector`).toContain(file);
		}
	});

	test('every exemption satisfies the BASIS it claims', () => {
		for (const entry of TRANSPORT_BYPASS_EXEMPTIONS) {
			expect(entry.reason.length, entry.file).toBeGreaterThan(40);
			const source = stripComments(readFileSync(join(REPO_ROOT, entry.file), 'utf8'));
			if (entry.basis === 'idempotent-actions') {
				expect(entry.actions.length, entry.file).toBeGreaterThan(0);
				for (const action of entry.actions) {
					expect(ACTION_IDEMPOTENCY.get(action), `${entry.file} → ${action}`).toBe('idempotent');
				}
			}
			if (entry.basis === 'single-shot') {
				// It must not ask ANY transport to resend for it: every `retries`
				// literal in the file is 1, and it does not import the retrying
				// transport. That is what makes a `mutating` action safe here.
				const retries = [...source.matchAll(/\bretries\s*:\s*(\d+)/g)].map((hit) => hit[1]);
				expect(
					retries.filter((value) => value !== '1'),
					entry.file,
				).toEqual([]);
				expect(/from\s+'[^']*api_transport\.js'/.test(source), entry.file).toBe(false);
				expect(entry.actions.length, entry.file).toBeGreaterThan(0);
			}
			if (entry.basis === 'not-gated-here') {
				expect(entry.reason).toContain('multipart');
			}
		}
	});

	test('every API transport outside data_manager.request ASKS the page-identity latch, or says why not', () => {
		const offenders = identityLatchOffenders(TRANSPORT_BYPASS_EXEMPTIONS);
		expect(
			offenders,
			'A transport that opens its own connection to the API sends whatever the page holds, even after a re-login as ANOTHER user revoked the page identity (LEAD-2). Ask error_dispatch.refused_by_page_identity(body) before sending, or state why the revoked page has nothing to lose there.',
		).toEqual([]);
		// anti-vacuity: the transports the latch was put on are seen asking. The
		// regex above proves only that each one CALLS the door; that the answer
		// stops the send is measured per transport by the client suite
		// (test_relogin_identity cases s, s2, s3).
		expect(TRANSPORT_BYPASS_EXEMPTIONS.filter((e) => e.identity_latch === 'asks').length).toBe(6);
		// positive control: an admitted hole is RED, whatever its file does
		const agent = TRANSPORT_BYPASS_EXEMPTIONS.find(
			(e) => e.file === 'tools/tool_assistant/js/agent_stream.js',
		);
		expect(agent).toBeDefined();
		const hole = identityLatchOffenders([
			{
				...(agent as (typeof TRANSPORT_BYPASS_EXEMPTIONS)[number]),
				identity_latch: { open_gap: 'probe' },
			},
		]);
		expect(hole.length).toBe(1);
		expect(hole[0]).toContain('OPEN GAP');
	});

	test("the login door the latch leaves open is exactly the server's session doors", () => {
		// error_dispatch.LOGIN_DOOR_ACTIONS is what a revoked page may still send.
		// It must not drift from the server: every PRE-AUTH dd_utils_api action
		// (NO_LOGIN_ACTIONS) is classified here, and the login doors among them,
		// plus `quit` (ends the session the page holds), are exactly the client set.
		// A new pre-auth action on the server is red here until it is classified.
		const PRE_AUTH_DD_UTILS: Readonly<Record<string, 'login_door' | { not_a_login_door: string }>> =
			{
				login: 'login_door',
				get_login_context: 'login_door',
				request_password_reset: 'login_door',
				confirm_password_reset: 'login_door',
				change_lang: {
					not_a_login_door:
						"session language: on a revoked page it would write this page's language choice into ANOTHER identity's session — the page is reloading anyway",
				},
				get_server_ready_status: {
					not_a_login_door: 'ontology-master surface for REMOTE installations — no page sends it',
				},
				get_ontology_update_info: {
					not_a_login_door:
						'ontology-master manifest for REMOTE installations — a maintenance widget read, not a login',
				},
				get_code_update_info: {
					not_a_login_door:
						'code-master manifest for REMOTE installations — a maintenance widget read, not a login',
				},
			};
		const serverPreAuth = [...NO_LOGIN_ACTIONS]
			.filter((key) => key.startsWith('dd_utils_api:'))
			.map((key) => key.slice('dd_utils_api:'.length))
			.sort();
		expect(serverPreAuth.length).toBeGreaterThan(3);
		expect(
			Object.keys(PRE_AUTH_DD_UTILS).sort(),
			'classify every pre-auth dd_utils_api action',
		).toEqual(serverPreAuth);
		// `quit` is a registered dd_utils_api action that is NOT pre-auth: it ends
		// the session the page holds
		expect(listRegisteredActions().map((p) => `${p.apiClass}:${p.action}`)).toContain(
			'dd_utils_api:quit',
		);

		const dispatchSource = stripComments(
			readFileSync(join(REPO_ROOT, 'client/dedalo/core/common/js/error_dispatch.js'), 'utf8'),
		);
		const literal = /export const LOGIN_DOOR_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(
			dispatchSource,
		);
		expect(literal, 'LOGIN_DOOR_ACTIONS is a literal Set in error_dispatch.js').not.toBeNull();
		const clientSet = [...(literal?.[1] ?? '').matchAll(/'([a-z_]+)'/g)]
			.map((m) => m[1] as string)
			.sort();
		const expected = [
			...Object.entries(PRE_AUTH_DD_UTILS)
				.filter(([, verdict]) => verdict === 'login_door')
				.map(([action]) => action),
			'quit',
		].sort();
		expect(clientSet).toEqual(expected);
	});

	test('the ONE door that is not behind Gate 4 still has the shape this gate claims', () => {
		// STATED, NOT GATED-AWAY: the multipart upload branch answers before
		// dispatchRqo, so no idempotency key is ever read for a chunk POST. This
		// pins the two facts the exemption above rests on — the branch exists, and
		// it returns without reaching dispatchRqo — so the claim cannot rot into a
		// false one while nobody is looking.
		const server = readFileSync(join(REPO_ROOT, 'src/server.ts'), 'utf8');
		const branch = server.indexOf("includes('multipart/form-data')");
		expect(branch, 'the multipart branch in src/server.ts moved or was renamed').toBeGreaterThan(0);
		const afterBranch = server.slice(branch, server.indexOf('dispatchRqo(', branch));
		expect(
			afterBranch,
			'the multipart branch no longer returns before dispatchRqo — if it now goes through the JSON door, Gate 4 covers it and this exemption must be deleted',
		).toContain('return handleMediaUpload(');
	});
});

// ---------------------------------------------------------------------------
// D — the REAL client transport stamps, and stamps ONCE per logical call
// ---------------------------------------------------------------------------

/**
 * `data_manager.js` is a browser module whose leaf imports need a DOM. It is
 * copied VERBATIM (with the real api_transport.js, api_error.js and the
 * import-free request_activity.js beside it)
 * into a scratch tree that reproduces the directory DEPTH its relative
 * specifiers assume, and the five leaves it does not need are written there as
 * minimal stubs (error_dispatch.js as a page whose identity is NOT revoked and
 * whose session is its own —
 * the latch itself is measured on the real modules by the Mocha suite
 * test_relogin_identity.js, case s). So the bytes under test are the shipped
 * bytes.
 */
let scratchRoot = '';
let dataManager: {
	request: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
let posted: Array<{ url: string; body: string | null }> = [];
let savedFetch: unknown;

const REAL_CLIENT = 'client/dedalo/core/common/js';

beforeAll(async () => {
	scratchRoot = mkdtempSync(join(tmpdir(), 'dd-idem-'));
	const jsDir = join(scratchRoot, 'client', 'dedalo', 'core', 'common', 'js');
	mkdirSync(join(jsDir, 'utils'), { recursive: true });
	for (const name of [
		'data_manager.js',
		'api_transport.js',
		'api_error.js',
		'request_activity.js',
	]) {
		cpSync(join(REPO_ROOT, REAL_CLIENT, name), join(jsDir, name));
	}
	writeFileSync(
		join(jsDir, 'utils', 'util.js'),
		'export const JSON_parse_safely = (text) => { try { return JSON.parse(text) } catch { return null } }\n',
	);
	writeFileSync(
		join(jsDir, 'event_manager.js'),
		'export const event_manager = {publish(){}, subscribe(){}, unsubscribe(){}}\n',
	);
	writeFileSync(join(jsDir, 'events.js'), 'export const dd_request_idle_callback = () => {}\n');
	writeFileSync(join(jsDir, 'render_api_error.js'), 'export const render_error_toast = () => {}\n');
	writeFileSync(
		join(jsDir, 'error_dispatch.js'),
		[
			'export const refused_by_page_identity = () => false',
			'export const is_login_door_body = () => false',
			"export const settle_session_identity = () => 'adopt'",
			'',
		].join('\n'),
	);

	const globals = globalThis as unknown as Record<string, unknown>;
	globals.window = { page_globals: { csrf_token: null, recovery_mode: false } };
	globals.page_globals = (globals.window as { page_globals: unknown }).page_globals;
	globals.SHOW_DEBUG = false;
	globals.DEDALO_API_URL = 'https://gate.invalid/api/v1/json/';
	globals.get_label = {};
	savedFetch = globals.fetch;
	globals.fetch = async (url: string, init: { signal?: AbortSignal; body?: string } = {}) => {
		if (String(url).includes('/health')) {
			// a DEAD health probe: the attempt keeps its plain deadline, so the run
			// is short and the busy extension never confuses the count.
			return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' };
		}
		posted.push({ url: String(url), body: init.body ?? null });
		return new Promise((_resolve, reject) => {
			init.signal?.addEventListener(
				'abort',
				() => {
					const error = new Error('aborted');
					error.name = 'AbortError';
					reject(error);
				},
				{ once: true },
			);
		});
	};
	dataManager = (await import(join(jsDir, 'data_manager.js'))).data_manager;

	const rows = (await sql.unsafe(`SELECT section_id FROM ${TABLE} WHERE section_tipo = $1`, [
		SECTION,
	])) as { section_id: number }[];
	for (const row of rows) preexisting.add(Number(row.section_id));
});

afterAll(() => {
	const globals = globalThis as unknown as Record<string, unknown>;
	globals.fetch = savedFetch;
	if (scratchRoot !== '') rmSync(scratchRoot, { recursive: true, force: true });
});

describe('D — the shipped transport stamps every request it may resend', () => {
	test('all attempts of ONE call carry ONE key, and the bodies are byte-identical', async () => {
		posted = [];
		await dataManager.request({
			body: { action: 'create', dd_api: 'dd_core_api' },
			timeout: 20,
			base_delay: 1,
		});
		// the DEFAULT retries (5) — the population the finding is about
		expect(posted.length).toBe(5);
		const bodies = posted.map((entry) => entry.body);
		expect(new Set(bodies).size, 'the attempts must be byte-identical').toBe(1);
		const key = JSON.parse(bodies[0] as string).idempotency_key as string;
		expect(key).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
	}, 20000);

	test('a retries:1 call carries no key — it cannot resend, so it needs none', async () => {
		posted = [];
		await dataManager.request({
			body: { action: 'save', dd_api: 'dd_core_api' },
			retries: 1,
			timeout: 20,
			base_delay: 1,
		});
		expect(posted.length).toBe(1);
		expect(JSON.parse(posted[0]?.body as string).idempotency_key).toBeUndefined();
	}, 20000);

	test('two calls are two operations: never the same key', async () => {
		posted = [];
		const body = { action: 'create', dd_api: 'dd_core_api' };
		await dataManager.request({ body, timeout: 20, base_delay: 1, retries: 2 });
		await dataManager.request({ body, timeout: 20, base_delay: 1, retries: 2 });
		expect(posted.length).toBe(4);
		const keys = posted.map((entry) => JSON.parse(entry.body as string).idempotency_key);
		expect(new Set(keys).size).toBe(2);
		// and the caller's own body object was never mutated
		expect(Object.hasOwn(body, 'idempotency_key')).toBe(false);
	}, 20000);

	test('DEFENCE IN DEPTH: a body that cannot be stamped is sent at most once', async () => {
		posted = [];
		await dataManager.request({
			// a caller that pre-serialized its own JSON: nothing can be injected into
			// it, so the transport must not resend it blind.
			body: JSON.stringify({ action: 'create', dd_api: 'dd_core_api' }),
			timeout: 20,
			base_delay: 1,
		});
		expect(posted.length).toBe(1);
	}, 20000);

	test('the LEGITIMATE retry is untouched: a bodyless GET still retries', async () => {
		posted = [];
		await dataManager.request({
			url: 'https://gate.invalid/lang.json',
			method: 'GET',
			body: null,
			retries: 3,
			timeout: 20,
			base_delay: 1,
		});
		expect(posted.length, 'a static-asset GET duplicates nothing and must keep retrying').toBe(3);
	}, 20000);
});

// ---------------------------------------------------------------------------
// E — the server honours the key, through the REAL create door
// ---------------------------------------------------------------------------

const SECTION = 'testmint1';
const TABLE = 'matrix_test';
const USER_ID = -1;
const minted: number[] = [];
/**
 * The ids that were there BEFORE this file ran. The sweep below subtracts them,
 * so a bug in the tracking (a probe handler answering a bare number, say) can
 * never make this gate delete a record it did not mint — the "a gate deleted
 * test218 out of a real install" hazard the suite's own preload header names.
 */
const preexisting = new Set<number>();

function context(): ApiRequestContext {
	const token = createSession(USER_ID, 'root', true);
	const session = getSession(token);
	return {
		requestId: `idem-${crypto.randomUUID()}`,
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
	} as ApiRequestContext;
}

function createRqo(key: string | null): Rqo {
	const rqo: Record<string, unknown> = {
		action: 'create',
		dd_api: 'dd_core_api',
		source: { model: 'section', tipo: SECTION, section_tipo: SECTION },
	};
	if (key !== null) rqo.idempotency_key = key;
	return rqo as Rqo;
}

/**
 * Through the REAL parse door, deliberately: the fingerprint is computed from
 * the ZOD-PARSED rqo, so "two byte-identical POSTs produce the same
 * fingerprint" is a claim about JSON.parse + zod, not about a JS literal reused
 * twice. Round-tripping the wire text here is what makes it a measurement.
 */
function parsedCreateRqo(key: string | null): Rqo {
	return rqoSchema.parse(JSON.parse(JSON.stringify(createRqo(key))));
}

async function dispatchCreate(key: string | null): Promise<ApiResult> {
	const ctx = context();
	ctx.principal = await resolvePrincipal(USER_ID);
	const result = await dispatchRqo(parsedCreateRqo(key), ctx);
	const created = (result.body as { data?: unknown }).data;
	if (typeof created === 'number') minted.push(created);
	return result;
}

const KEY_A = 'idemgatekeyaaaaaaaaaaaaaaaaaaaa1';
const KEY_B = 'idemgatekeybbbbbbbbbbbbbbbbbbbb2';
const KEY_C = 'idemgatekeycccccccccccccccccccc3';
const KEY_D = 'idemgatekeydddddddddddddddddddd4';
const KEY_E = 'idemgatekeyeeeeeeeeeeeeeeeeeeee5';

afterAll(async () => {
	const ours = minted.filter((id) => !preexisting.has(id));
	for (const id of ours) {
		await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
			SECTION,
			id,
		]);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[SECTION, id],
		);
	}
	if (ours.length > 0) {
		// the dd542 activity rows the create door appends for OUR record ids
		await sql.unsafe(
			`DELETE FROM matrix_activity
			 WHERE section_tipo = 'dd542'
			   AND string->'dd546'->0->>'value' = $1
			   AND misc->'dd551'->0->'value'->>'section_id' = ANY($2::text[])`,
			[SECTION, `{${ours.map(String).join(',')}}`],
		);
	}
	resetIdempotencyLedgerForTests();
});

describe('E — the same key twice makes ONE record, and both answers match', () => {
	test('POSITIVE CONTROL: no key at all still makes TWO records (the defect is real)', async () => {
		resetIdempotencyLedgerForTests();
		const first = await dispatchCreate(null);
		const second = await dispatchCreate(null);
		const a = (first.body as { data?: unknown }).data;
		const b = (second.body as { data?: unknown }).data;
		expect(typeof a).toBe('number');
		expect(a).not.toBe(b);
		expect(idempotencyLedgerStats().entries).toBe(0);
	}, 60000);

	test('POSITIVE CONTROL: two DIFFERENT keys still make two records', async () => {
		resetIdempotencyLedgerForTests();
		const first = await dispatchCreate(KEY_A);
		const second = await dispatchCreate(KEY_B);
		expect((first.body as { data?: unknown }).data).not.toBe(
			(second.body as { data?: unknown }).data,
		);
		expect(idempotencyLedgerStats().entries).toBe(2);
	}, 60000);

	test('THE FIX: the same key twice executes ONCE and replays the original answer', async () => {
		resetIdempotencyLedgerForTests();
		const before = await recordCount();
		const first = await dispatchCreate(KEY_C);
		const second = await dispatchCreate(KEY_C);
		expect(await recordCount()).toBe(before + 1);
		expect(first.status).toBe(second.status);
		expect((second.body as { data?: unknown }).data).toBe((first.body as { data?: unknown }).data);
		expect((second.body as { ok?: unknown }).ok).toBe(true);
		// the replay says so, for the operator's log and for this gate
		expect((second.body as Record<string, unknown>).idempotent_replay).toBe(true);
		expect((first.body as Record<string, unknown>).idempotent_replay).toBeUndefined();
	}, 60000);

	test('CONCURRENCY: two identical requests IN FLIGHT at once execute once', async () => {
		resetIdempotencyLedgerForTests();
		const before = await recordCount();
		// no await between them — this is the shape a retry storm produces
		const [first, second] = await Promise.all([dispatchCreate(KEY_D), dispatchCreate(KEY_D)]);
		expect(await recordCount()).toBe(before + 1);
		expect((second.body as { data?: unknown }).data).toBe((first.body as { data?: unknown }).data);
		// exactly one of the pair is the replay — the other is the leader
		const replays = [first, second].filter(
			(result) => (result.body as Record<string, unknown>).idempotent_replay === true,
		);
		expect(replays.length).toBe(1);
	}, 60000);

	test('the same key with a DIFFERENT request is refused, and writes nothing', async () => {
		resetIdempotencyLedgerForTests();
		await dispatchCreate(KEY_E);
		const before = await recordCount();
		const ctx = context();
		ctx.principal = await resolvePrincipal(USER_ID);
		const clash = await dispatchRqo(
			{
				action: 'create',
				dd_api: 'dd_core_api',
				idempotency_key: KEY_E,
				source: { model: 'section', tipo: SECTION, section_tipo: SECTION, mode: 'edit' },
			} as unknown as Rqo,
			ctx,
		);
		expect(clash.status).toBe(409);
		expect((clash.body as { error?: { code?: string } }).error?.code).toBe(
			'idempotency.key_reused',
		);
		expect(await recordCount()).toBe(before);
	}, 60000);

	test('a read carrying a key is never ledgered (idempotent, and the volume)', async () => {
		resetIdempotencyLedgerForTests();
		const ctx = context();
		ctx.principal = await resolvePrincipal(USER_ID);
		expect(idempotencyLedgerKey(createRqo(KEY_A), ctx, 'dd_core_api:read')).toBeNull();
		expect(idempotencyLedgerKey(createRqo(KEY_A), ctx, 'dd_core_api:create')).not.toBeNull();
	});

	test('an UNAUTHENTICATED request is never ledgered (the enumerated exclusion)', async () => {
		const anon = { ...context(), session: null } as ApiRequestContext;
		expect(idempotencyLedgerKey(createRqo(KEY_A), anon, 'dd_core_api:create')).toBeNull();
	});

	test('the key is scoped to the principal: one user cannot replay another’s', async () => {
		const ctx = context();
		const other = { ...ctx, session: { ...ctx.session, userId: 7 } } as ApiRequestContext;
		expect(idempotencyLedgerKey(createRqo(KEY_A), ctx, 'dd_core_api:create')).not.toBe(
			idempotencyLedgerKey(createRqo(KEY_A), other, 'dd_core_api:create'),
		);
	});

	/**
	 * THE AMBIGUOUS-OUTCOME RULE — and the reason this case replaced the one that
	 * shipped in the first draft.
	 *
	 * That case threw BEFORE writing anything and asserted that the retry
	 * EXECUTED, so it pinned the very behaviour that re-admits CLI-01: the two
	 * write doors under this gate commit outside any transaction — duplicate_record
	 * opens none at all, and dd_core_api:create commits its row and only then
	 * fires the save event and the activity row — so a throw can perfectly well
	 * follow a commit, and re-executing it makes a SECOND clone of a heritage
	 * record.
	 *
	 * The probe below is that exact shape: it runs the REAL create door (which
	 * commits) and then throws. The retry must be REFUSED, not run.
	 */
	test('AMBIGUOUS OUTCOME: a handler that WROTE and then threw is never re-executed', async () => {
		resetIdempotencyLedgerForTests();
		const table = actionTableFor('dd_core_api');
		if (table === undefined) throw new Error('dd_core_api is not registered');
		const original = table.create;
		let calls = 0;
		const before = await recordCount();
		try {
			table.create = async (probeRqo, handlerContext) => {
				calls++;
				const result = await (original as NonNullable<typeof original>)(probeRqo, handlerContext);
				const created = (result.body as { data?: unknown }).data;
				// tracked for the sweep BEFORE the throw — the record is committed and
				// this file must not leave it behind
				if (typeof created === 'number') minted.push(created);
				throw new Error('the commit landed; this attempt failed after it');
			};
			const first = await dispatchCreate(KEY_A);
			expect((first.body as { ok?: unknown }).ok).toBe(false);
			expect(
				await recordCount(),
				'the probe must actually commit — otherwise this case proves nothing',
			).toBe(before + 1);
			// THE FIX: the reservation is KEPT, marked ambiguous. The first draft
			// deleted it here.
			expect(idempotencyLedgerStats().entries).toBe(1);

			const second = await dispatchCreate(KEY_A);
			expect(calls, 'the retry after an AMBIGUOUS failure must NOT execute').toBe(1);
			expect(await recordCount(), 'no second heritage record').toBe(before + 1);
			expect(second.status).toBe(409);
			expect((second.body as { error?: { code?: string } }).error?.code).toBe(
				'idempotency.outcome_unknown',
			);
			// and it is NOT retryable — a retryable code here would put the browser
			// transport straight back into the loop this whole change set removes
			expect((second.body as { error?: { retryable?: unknown } }).error?.retryable).toBe(false);
			// IT NAMES WHAT TO CHECK, on the wire and not only in the server log:
			// which action, which request_id the ambiguous attempt carried (so the
			// operator can find it in the access log), and what it failed with.
			const details = (second.body as { error?: { details?: Record<string, unknown> } }).error
				?.details;
			expect(details?.action).toBe('dd_core_api:create');
			expect(
				details?.original_request_id,
				'the refusal must point at the ATTEMPT whose outcome is unknown',
			).toBe((first.body as { request_id?: string }).request_id);
			expect(details?.original_error_code).toBe('internal.unexpected');
		} finally {
			table.create = original as never;
		}
	}, 60000);

	test('the operator is not locked out: a NEW key for the same work executes', async () => {
		// The key names ONE LOGICAL OPERATION and the transport mints it per call,
		// so a curator's own deliberate re-click is a new key and a new execution.
		// Only the AUTOMATIC resend of the ambiguous attempt is refused.
		resetIdempotencyLedgerForTests();
		const before = await recordCount();
		const table = actionTableFor('dd_core_api');
		if (table === undefined) throw new Error('dd_core_api is not registered');
		const original = table.create;
		try {
			table.create = async (probeRqo, handlerContext) => {
				const result = await (original as NonNullable<typeof original>)(probeRqo, handlerContext);
				const created = (result.body as { data?: unknown }).data;
				if (typeof created === 'number') minted.push(created);
				throw new Error('ambiguous');
			};
			await dispatchCreate(KEY_D);
		} finally {
			table.create = original as never;
		}
		expect(await recordCount()).toBe(before + 1);
		// same operation, a NEW key — the ordinary door, wide open
		const again = await dispatchCreate(KEY_E);
		expect((again.body as { ok?: unknown }).ok).toBe(true);
		expect(await recordCount()).toBe(before + 2);
	}, 60000);

	test('a CONCURRENT twin of an ambiguous leader is refused too, never executed', async () => {
		resetIdempotencyLedgerForTests();
		const table = actionTableFor('dd_core_api');
		if (table === undefined) throw new Error('dd_core_api is not registered');
		const original = table.create;
		let calls = 0;
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			table.create = async () => {
				calls++;
				await held;
				throw new Error('committed, then failed');
			};
			const ctx = context();
			ctx.principal = await resolvePrincipal(USER_ID);
			const leader = dispatchRqo(parsedCreateRqo(KEY_B), ctx);
			for (let turn = 0; turn < 1000 && idempotencyLedgerStats().entries === 0; turn++) {
				await Promise.resolve();
			}
			expect(idempotencyLedgerStats().entries).toBe(1);
			const twinContext = context();
			twinContext.principal = await resolvePrincipal(USER_ID);
			const twin = dispatchRqo(parsedCreateRqo(KEY_B), twinContext);
			release();
			const [leaderResult, twinResult] = await Promise.all([leader, twin]);
			expect(calls, 'the twin must never have executed').toBe(1);
			// The LEADER is told the truth about its OWN attempt…
			expect((leaderResult.body as { ok?: unknown }).ok).toBe(false);
			expect((leaderResult.body as { error?: { code?: string } }).error?.code).not.toBe(
				'idempotency.outcome_unknown',
			);
			// …and the twin, which cannot know, is told the outcome is unknown.
			expect((twinResult.body as { error?: { code?: string } }).error?.code).toBe(
				'idempotency.outcome_unknown',
			);
		} finally {
			table.create = original as never;
			resetIdempotencyLedgerForTests();
		}
	}, 60000);
});

async function recordCount(): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM ${TABLE} WHERE section_tipo = $1`,
		[SECTION],
	)) as { n: number }[];
	return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// F — the ledger is BOUNDED, and every bound is tripped here
// ---------------------------------------------------------------------------

describe('F — the ledger bounds', () => {
	test('the declared bounds are finite and cover the whole measured retry span', () => {
		const stats = idempotencyLedgerStats();
		// the transport's own worst case, MEASURED: 5 attempts over 78 s with the
		// busy probe extending each deadline. The TTL must be far above it.
		expect(stats.ttlMs).toBeGreaterThan(5 * 60 * 1000);
		expect(stats.maxEntries).toBeGreaterThan(0);
		expect(stats.maxTotalBytes).toBeGreaterThan(0);
		expect(stats.maxBodyBytes).toBeGreaterThan(0);
		expect(stats.maxBodyBytes).toBeLessThanOrEqual(stats.maxTotalBytes);
		// the per-principal caps are the ones that carry the "one operator cannot
		// evict another's entries" property, so they must be STRICTLY under the
		// process-wide backstop — equal caps would make the backstop the only bound
		// and the property false again.
		expect(stats.maxEntriesPerPrincipal).toBeGreaterThan(0);
		expect(stats.maxEntriesPerPrincipal).toBeLessThan(stats.maxEntries);
		expect(stats.maxBytesPerPrincipal).toBeGreaterThan(0);
		expect(stats.maxBytesPerPrincipal).toBeLessThan(stats.maxTotalBytes);
		// a twin's wait is bounded, and the bound sits past the transport's own 5 s
		// per-attempt deadline so an ordinary slow leader is still de-duplicated
		expect(stats.twinWaitMs).toBeGreaterThan(5000);
		expect(stats.twinWaitMs).toBeLessThanOrEqual(60000);
	});

	test('AGE: an entry older than the TTL is evicted, and its bytes come back', async () => {
		resetIdempotencyLedgerForTests();
		await dispatchCreate(KEY_B);
		expect(idempotencyLedgerStats().entries).toBe(1);
		expect(idempotencyLedgerStats().bytes).toBeGreaterThan(0);
		sweepIdempotencyLedgerForTests(Date.now() + idempotencyLedgerStats().ttlMs + 1);
		expect(idempotencyLedgerStats().entries).toBe(0);
		expect(idempotencyLedgerStats().bytes).toBe(0);
	}, 60000);

	/**
	 * THE TTL MUST BE ENFORCED WHERE REQUESTS READ IT. The first draft swept only
	 * from the leader's SUCCESS path, so `withIdempotency` replayed on a bare
	 * `ledger.get` with no age check: on a ledger that had stopped receiving
	 * successful writes, a fifteen-minute window was in fact an unbounded one.
	 * This drives the REAL read path with the clock moved past the TTL.
	 */
	test('TTL: the READ path refuses to replay an expired entry, and re-executes', async () => {
		resetIdempotencyLedgerForTests();
		const table = actionTableFor('dd_core_api');
		if (table === undefined) throw new Error('dd_core_api is not registered');
		const original = table.create;
		const realNow = Date.now;
		let calls = 0;
		// everything that touches the DB or the session store happens on the REAL
		// clock, before it is moved
		const first = context();
		first.principal = await resolvePrincipal(USER_ID);
		const second = context();
		second.principal = await resolvePrincipal(USER_ID);
		const third = context();
		third.principal = await resolvePrincipal(USER_ID);
		try {
			table.create = async (_probeRqo, handlerContext) => {
				calls++;
				return {
					status: 200,
					body: ok({ probe: calls }, { requestId: handlerContext.requestId }),
				};
			};
			await dispatchRqo(parsedCreateRqo(KEY_C), first);
			expect(calls).toBe(1);
			// INSIDE the window: replayed, not executed
			const replay = await dispatchRqo(parsedCreateRqo(KEY_C), second);
			expect(calls, 'a request inside the TTL must replay').toBe(1);
			expect((replay.body as Record<string, unknown>).idempotent_replay).toBe(true);

			// PAST the window, on the same ledger
			const ttl = idempotencyLedgerStats().ttlMs;
			Date.now = () => realNow() + ttl + 60_000;
			const afterTtl = await dispatchRqo(parsedCreateRqo(KEY_C), third);
			expect(calls, 'past the TTL the request must EXECUTE, not replay').toBe(2);
			expect((afterTtl.body as Record<string, unknown>).idempotent_replay).toBeUndefined();
		} finally {
			Date.now = realNow;
			table.create = original as never;
			resetIdempotencyLedgerForTests();
		}
	}, 60000);

	test('CAPACITY: an over-full ledger is evicted back under its process-wide bound', () => {
		resetIdempotencyLedgerForTests();
		const stats = idempotencyLedgerStats();
		// one principal each, so this drives the BACKSTOP and not the per-principal cap
		seedIdempotencyLedgerForTests(stats.maxEntries + 10, 64);
		expect(idempotencyLedgerStats().entries).toBeGreaterThan(stats.maxEntries);
		sweepIdempotencyLedgerForTests(Date.now());
		expect(idempotencyLedgerStats().entries).toBeLessThanOrEqual(stats.maxEntries);
		// eviction is oldest-first, so the SURVIVORS are the newest — a retry
		// arriving now still finds its own entry.
		resetIdempotencyLedgerForTests();
	});

	test('BYTES: an over-heavy ledger is evicted back under its byte bound', () => {
		resetIdempotencyLedgerForTests();
		const stats = idempotencyLedgerStats();
		const each = 64 * 1024;
		seedIdempotencyLedgerForTests(Math.ceil(stats.maxTotalBytes / each) + 4, each);
		expect(idempotencyLedgerStats().bytes).toBeGreaterThan(stats.maxTotalBytes);
		sweepIdempotencyLedgerForTests(Date.now());
		expect(idempotencyLedgerStats().bytes).toBeLessThanOrEqual(stats.maxTotalBytes);
		resetIdempotencyLedgerForTests();
	});

	/**
	 * THE EVICTION CLAIM, MADE TRUE. The header used to say an anonymous caller
	 * must not be able to evict an operator's entries — while the only bounds
	 * were GLOBAL, so any authenticated user could evict any other's. The bounds
	 * are now per-principal first, and this drives that through the REAL leader
	 * path: a busy operator's own overflow prunes the busy operator's OWN entries
	 * and leaves a bystander's alone.
	 */
	test('PER PRINCIPAL: an operator’s own volume never evicts another operator’s entries', async () => {
		resetIdempotencyLedgerForTests();
		const stats = idempotencyLedgerStats();
		const BYSTANDER = 3;
		// the BYSTANDER's entries are seeded FIRST, so they are the oldest: a
		// global oldest-first eviction would take these and no others.
		seedIdempotencyLedgerForTests(BYSTANDER, 64, 'bystander-operator');
		// the busy operator is the REAL principal this suite dispatches as, so the
		// dispatch below completes into the same principal scope
		const overflow = stats.maxEntriesPerPrincipal + 20;
		seedIdempotencyLedgerForTests(overflow, 64, String(USER_ID));
		expect(idempotencyLedgerStats().entries).toBe(BYSTANDER + overflow);

		const table = actionTableFor('dd_core_api');
		if (table === undefined) throw new Error('dd_core_api is not registered');
		const original = table.create;
		try {
			table.create = async (_probeRqo, handlerContext) => ({
				status: 200,
				body: ok({ probe: true }, { requestId: handlerContext.requestId }),
			});
			const ctx = context();
			ctx.principal = await resolvePrincipal(USER_ID);
			await dispatchRqo(parsedCreateRqo(KEY_A), ctx);
		} finally {
			table.create = original as never;
		}

		// the busy operator is back at its own cap; the arithmetic is what proves
		// the bystander was untouched — 3 + 100 survives, and a sweep that had
		// crossed principals would have left fewer.
		expect(idempotencyLedgerStats().entries).toBe(BYSTANDER + stats.maxEntriesPerPrincipal);
		resetIdempotencyLedgerForTests();
	}, 60000);

	test('PER PRINCIPAL, BYTES: the same, on the byte half of the cap', async () => {
		resetIdempotencyLedgerForTests();
		const stats = idempotencyLedgerStats();
		const each = 64 * 1024;
		// the bystander's entries are BIG on purpose: their bytes are what makes
		// this case discriminating. If the sweep crossed principals it would take
		// these two first (they are the oldest) and the total below would collapse
		// to one principal's cap.
		const bystanderBytes = 2 * each;
		seedIdempotencyLedgerForTests(2, each, 'bystander-operator');
		seedIdempotencyLedgerForTests(
			Math.ceil(stats.maxBytesPerPrincipal / each) + 3,
			each,
			String(USER_ID),
		);
		expect(idempotencyLedgerStats().bytes).toBeGreaterThan(stats.maxBytesPerPrincipal);
		const table = actionTableFor('dd_core_api');
		if (table === undefined) throw new Error('dd_core_api is not registered');
		const original = table.create;
		try {
			table.create = async (_probeRqo, handlerContext) => ({
				status: 200,
				body: ok({ probe: true }, { requestId: handlerContext.requestId }),
			});
			const ctx = context();
			ctx.principal = await resolvePrincipal(USER_ID);
			await dispatchRqo(parsedCreateRqo(KEY_B), ctx);
		} finally {
			table.create = original as never;
		}
		const after = idempotencyLedgerStats().bytes;
		// the BUSY principal is back under ITS cap …
		expect(after).toBeLessThanOrEqual(stats.maxBytesPerPrincipal + bystanderBytes + 4096);
		// … and the bystander's bytes are STILL on the ledger, which is only
		// possible if the sweep stayed inside the busy principal's own entries.
		expect(
			after,
			'the bystander operator’s entries were evicted by another operator’s volume',
		).toBeGreaterThan(stats.maxBytesPerPrincipal);
		resetIdempotencyLedgerForTests();
	}, 60000);

	test('IN FLIGHT is never evicted — its twin still has to be answered', async () => {
		resetIdempotencyLedgerForTests();
		const table = actionTableFor('dd_core_api');
		if (table === undefined) throw new Error('dd_core_api is not registered');
		const original = table.create;
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			table.create = async (_rqo, handlerContext) => {
				await held;
				// an OBJECT, for the reason the other probe states
				return { status: 200, body: ok({ probe: true }, { requestId: handlerContext.requestId }) };
			};
			// the context is resolved FIRST (it hits the DB), so that the only thing
			// left between starting the dispatch and this assertion is the gate chain
			const ctx = context();
			ctx.principal = await resolvePrincipal(USER_ID);
			const leader = dispatchRqo(parsedCreateRqo(KEY_C), ctx);
			// BOUNDED spin: yield until the reservation appears, then give up loudly.
			// An unbounded wait here would HANG the suite the day the reservation
			// stops being made — which is precisely the regression this file exists
			// to catch, and a hang reports nothing.
			for (let turn = 0; turn < 1000 && idempotencyLedgerStats().entries === 0; turn++) {
				await Promise.resolve();
			}
			expect(
				idempotencyLedgerStats().entries,
				'the leader never reserved its key — the idempotency gate is not running',
			).toBe(1);
			// a sweep far past the TTL, while the leader is still running
			sweepIdempotencyLedgerForTests(Date.now() + idempotencyLedgerStats().ttlMs * 10);
			expect(
				idempotencyLedgerStats().entries,
				'evicting an in-flight entry would leave its twin awaiting a promise nobody publishes',
			).toBe(1);
			const twinContext = context();
			twinContext.principal = await resolvePrincipal(USER_ID);
			const twin = dispatchRqo(parsedCreateRqo(KEY_C), twinContext);
			release();
			const [a, b] = await Promise.all([leader, twin]);
			// toEqual, not toBe: each replay parses its OWN copy of the stored
			// answer, so the stored bytes cannot be mutated by whoever reads them.
			expect((b.body as { data?: unknown }).data).toEqual((a.body as { data?: unknown }).data);
			expect((b.body as Record<string, unknown>).idempotent_replay).toBe(true);
		} finally {
			table.create = original as never;
			resetIdempotencyLedgerForTests();
		}
	}, 60000);
});

// ---------------------------------------------------------------------------
// G — a twin NEVER waits forever
// ---------------------------------------------------------------------------

/**
 * The reviewer's fourth must-fix: `await entry.pending` had no deadline, so a
 * leader blocked on a Postgres row lock pinned one socket per twin for as long
 * as the lock held — and this engine now takes owner row locks from read to
 * COMMIT on the delete path, which is exactly that shape.
 *
 * Two cases, because they prove different things: the MECHANISM (driven at a
 * millisecond deadline, so the guard's own branch is exercised) and the WIRING
 * (a real twin, on a real stuck leader, at the real production bound — the only
 * way to show that replayIdempotentTwin actually calls it).
 */
describe('G — the twin wait is bounded', () => {
	test('MECHANISM: the bounded wait refuses instead of hanging', async () => {
		const neverSettles = new Promise<never>(() => undefined);
		await expect(
			awaitLeaderBounded(neverSettles as never, 'dd_core_api:create', 5),
		).rejects.toThrow(/still running/);
	});

	test('WIRING: a real twin of a STUCK leader is refused at the production bound', async () => {
		resetIdempotencyLedgerForTests();
		const table = actionTableFor('dd_core_api');
		if (table === undefined) throw new Error('dd_core_api is not registered');
		const original = table.create;
		let release: () => void = () => undefined;
		const stuck = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			table.create = async (_rqo, handlerContext) => {
				await stuck;
				return { status: 200, body: ok({ probe: true }, { requestId: handlerContext.requestId }) };
			};
			const ctx = context();
			ctx.principal = await resolvePrincipal(USER_ID);
			const leader = dispatchRqo(parsedCreateRqo(KEY_D), ctx);
			for (let turn = 0; turn < 1000 && idempotencyLedgerStats().entries === 0; turn++) {
				await Promise.resolve();
			}
			expect(idempotencyLedgerStats().entries).toBe(1);
			const twinContext = context();
			twinContext.principal = await resolvePrincipal(USER_ID);
			const startedAt = Date.now();
			const twin = await dispatchRqo(parsedCreateRqo(KEY_D), twinContext);
			const waited = Date.now() - startedAt;
			expect(twin.status).toBe(409);
			expect((twin.body as { error?: { code?: string } }).error?.code).toBe(
				'idempotency.in_progress',
			);
			// it really waited for the bound, and really stopped there
			expect(waited).toBeGreaterThanOrEqual(idempotencyLedgerStats().twinWaitMs - 500);
			expect(waited).toBeLessThan(idempotencyLedgerStats().twinWaitMs + 5000);
			// the leader is untouched: it finishes and its answer is still replayable
			release();
			const leaderResult = await leader;
			expect((leaderResult.body as { ok?: unknown }).ok).toBe(true);
		} finally {
			release();
			table.create = original as never;
			resetIdempotencyLedgerForTests();
		}
	}, 60000);
});
