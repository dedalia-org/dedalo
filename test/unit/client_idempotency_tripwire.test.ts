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
 * WHAT IS PINNED, in eight blocks:
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
 *  H. `tool_request` IS CLASSIFIED BY THE NESTED ACTION. The static row stays
 *     `mutating` (block A), but a tool action that DECLARES `readOnly`
 *     (src/core/tools/module.ts) is taken off the ledger per request: the same
 *     key twice executes twice, the ledger stays empty, a throwing handler (an
 *     upstream `external.http_status`) surfaces its REAL error on the resend
 *     instead of `idempotency.outcome_unknown`, and the handler runs inside the
 *     read-only request scope. The default (no flag) is unchanged — executes once,
 *     replays — and so is every doubt: an unknown tool or action, a background
 *     request, a flag the client merely CLAIMS, an identically named action of
 *     another tool, a classifier whose lookup THROWS, and a caller the tool is not
 *     GRANTED to (the ledger's behaviour on a resend must not tell an ungranted
 *     caller which tools or actions exist or declare readOnly: one sequence
 *     whatever they name). Block C carries the client half: the one `tool_request`
 *     forwarder passes `retries`/`timeout`/`busy_notice` ONLY when the caller gave
 *     a usable one, and every `tool_request(` call site passes a literal `retries`.
 *     A read-only action is not ledgered, so a default-retries caller would re-run
 *     a third-party lookup up to five times; hence, for a TOOL THAT DECLARES a
 *     `readOnly` action (derived from the loaded modules): its `tool_request(`
 *     calls are read at depth 0 (the call's own `action` / `retries`, a later
 *     property or spread overriding as at runtime); a call of a read-only action
 *     passes the literal `retries: 1`; a call whose action is not a literal passes
 *     it too (a call that is `retries: 1` is safe whatever it names); and the
 *     other spellings of the door are refused outright — a hand-built request body
 *     (`dd_api: 'dd_tools_api'` / `action: 'tool_request'`, the v6 shape),
 *     `create_source(x, '<read-only action>')`, and `x.tool_request` used as a value
 *     (`.call` / `.bind` / an alias) — because the census cannot follow where they
 *     end up. NOT COVERED: a read-only action requested from another tool's code or
 *     from `client/` by an inline `source: { model: 'tool_x', action }`.
 *     Block D carries the transport half: `retries` is normalised ONCE, so an
 *     `undefined` / `null` / `NaN` cannot split the stamp from the resend count.
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
 * helper that did left with the browser wizard); the one forwarder that passes a
 * CALLER's value (tool_common.js `tool_request`) is pinned by behaviour in block C
 * instead, because its own call site spells no literal. (5) The census
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
import { insertMatrixRecordWithCounter } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { ok } from '../../src/core/errors/convert.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { inReadOnlyScope } from '../../src/core/security/read_only_scope.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import { isReadOnlyToolRequest } from '../../src/core/tools/dispatch.ts';
import {
	BACKGROUND_JOB_STATUS_ACTION,
	BACKGROUND_JOBS_ACTION,
} from '../../src/core/tools/job_status.ts';
import { getLoadedTool, loadToolModules } from '../../src/core/tools/loader.ts';
import type { ToolActionSpec } from '../../src/core/tools/module.ts';
import { isToolGranted } from '../../src/core/tools/security.ts';
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
	// A read MAY write since 2026-10-30 — the external-mirror refresh
	// (source.build_options.get_data_external → section/record/external_refresh.ts).
	// It stays idempotent: the mirror is a pure function of committed data and a
	// second run finds no drift and writes nothing (dispatch.ts, its
	// ACTION_IDEMPOTENCY row) — an OUTCOME the refresh gate holds: a second
	// identical refresh call writes no row and no Time Machine entry.
	'dd_core_api:read',
	'dd_core_api:read_raw',
	// The "Open relationships" census: grouped + per-target COUNTs, no write.
	'dd_core_api:relation_targets',
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

/**
 * Index just past the string or template literal that OPENS at `start`, or the
 * text length when it never closes. A template's `${ ... }` is skipped as a
 * bracketed span, so a quote inside an interpolation does not end the literal.
 */
function skipQuoted(text: string, start: number): number {
	const quote = text[start] as string;
	let index = start + 1;
	while (index < text.length) {
		const char = text[index] as string;
		if (char === '\\') {
			index += 2;
		} else if (char === quote) {
			return index + 1;
		} else if (quote === '`' && char === '$' && text[index + 1] === '{') {
			const after = skipBracketed(text, index + 1);
			index = after === -1 ? text.length : after;
		} else {
			index += 1;
		}
	}
	return text.length;
}

/**
 * Index just past the bracket that CLOSES the one opening at `start`, string- and
 * template-aware (a `}` inside a quoted value does not close an object), or -1
 * when it never closes.
 */
function skipBracketed(text: string, start: number): number {
	let depth = 0;
	let index = start;
	while (index < text.length) {
		const char = text[index] as string;
		if (char === '"' || char === "'" || char === '`') {
			index = skipQuoted(text, index);
			continue;
		}
		if (char === '(' || char === '{' || char === '[') depth++;
		else if (char === ')' || char === '}' || char === ']') {
			depth--;
			if (depth === 0) return index + 1;
		}
		index += 1;
	}
	return -1;
}

/** `text` split at its depth-0 commas (string-, template- and bracket-aware), trimmed, empties dropped. */
function splitTopLevel(text: string): string[] {
	const parts: string[] = [];
	let from = 0;
	let index = 0;
	while (index < text.length) {
		const char = text[index] as string;
		if (char === '"' || char === "'" || char === '`') {
			index = skipQuoted(text, index);
		} else if (char === '(' || char === '{' || char === '[') {
			const after = skipBracketed(text, index);
			index = after === -1 ? text.length : after;
		} else if (char === ',') {
			parts.push(text.slice(from, index));
			index += 1;
			from = index;
		} else {
			index += 1;
		}
	}
	parts.push(text.slice(from));
	return parts.map((part) => part.trim()).filter((part) => part !== '');
}

/**
 * The argument text of a call whose `(` is at `open`: the bytes between the
 * parentheses, or null when they never close. STRING-AWARE — a `}` or `)` inside
 * a quoted value or a template does not end the call (the first draft counted
 * brackets inside strings too: a lookup's `'{'` in an option made the argument
 * unreadable). Over the 398 `data_manager.request` / `tool_request` /
 * `create_source` sites of 2026-11-06 the two readers agreed on every one.
 */
function callArgument(source: string, open: number): string | null {
	const end = skipBracketed(source, open);
	return end === -1 ? null : source.slice(open + 1, end - 1);
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
 * A `tool_request(` call: the tool convenience wrapper (tool_common.js) that
 * forwards `retries`/`timeout`/`busy_notice` to data_manager.request. Whitespace
 * is allowed before the `(` so a formatter-split chain still reads; the
 * definition (`tool_request = async function(`) and the label strings
 * ('tool_request: missing action') have no `(` after the name.
 */
const TOOL_REQUEST_SITE_PATTERN = /\btool_request\s*\(/g;

/** The one file that defines the wrapper and forwards its transport options. */
const TOOL_REQUEST_FORWARDER = 'client/dedalo/core/tools_common/js/tool_common.js';

interface ToolRequestSite {
	file: string;
	line: number;
	/**
	 * The text of the call's OWN `retries:` property, or null when it spells none.
	 * A spread or a computed key in the argument (`{ ...x }`) reads as `'...'`: it
	 * may carry a `retries` of its own, so nothing before it counts.
	 */
	retries: string | null;
	/** The call's OWN action when it is a string LITERAL, else null (a variable, a shorthand, a spread...). */
	action: string | null;
}

/** The marker a spread / computed key leaves in a site's `retries` (never a digit, so never "literal"). */
const SPREAD_MARK = '...';

/**
 * The depth-0 properties of an object-literal argument, in source order, or null
 * when the argument is not an object literal (a variable, a call...). A key is
 * null for a spread and for anything this reader cannot name (a computed key, a
 * method): such a property may carry ANY key, so the reader treats it as one that
 * overrides every earlier one. A shorthand `{ action }` reads as key `action`,
 * value `action` (the identifier, never a literal).
 */
function objectLiteralProperties(
	argument: string,
): Array<{ key: string | null; value: string }> | null {
	const text = argument.trim();
	if (!text.startsWith('{')) return null;
	const close = skipBracketed(text, 0);
	const body = close === -1 ? text.slice(1) : text.slice(1, close - 1);
	return splitTopLevel(body).map((segment) => {
		if (segment.startsWith('...')) return { key: null, value: segment.slice(3).trim() };
		const named = /^(?:([A-Za-z_$][\w$]*)|(['"`])([A-Za-z0-9_$]+)\2)\s*(?::([\s\S]*))?$/.exec(
			segment,
		);
		if (named === null) return { key: null, value: segment };
		const key = (named[1] ?? named[3]) as string;
		return { key, value: named[4] === undefined ? key : named[4].trim() };
	});
}

/**
 * What a `tool_request(` argument says about its action and its retries, read at
 * DEPTH 0 only and in order, so a later property overrides an earlier one exactly
 * as the object does: a nested `options: { retries: 1 }` is the action's own
 * option and not a transport count, a nested `options: { action: 'x' }` is not
 * the call's action, and a spread after the keys could replace either.
 */
function readToolRequestArgument(argument: string): Pick<ToolRequestSite, 'action' | 'retries'> {
	const properties = objectLiteralProperties(argument);
	// not an object literal (`tool_request(options)`): nothing about it is readable
	if (properties === null) return { action: null, retries: SPREAD_MARK };
	let action: string | null = null;
	let retries: string | null = null;
	for (const { key, value } of properties) {
		if (key === null) {
			action = null;
			retries = SPREAD_MARK;
		} else if (key === 'action') {
			action = /^(['"`])([A-Za-z0-9_]+)\1$/.exec(value)?.[2] ?? null;
		} else if (key === 'retries') {
			retries = value;
		}
	}
	return { action, retries };
}

/**
 * Every `tool_request(` call site in a source text, with the `retries` and the
 * literal `action` its argument spells at depth 0 (readToolRequestArgument).
 */
function toolRequestSitesIn(file: string, raw: string): ToolRequestSite[] {
	const source = stripComments(raw);
	const pattern = new RegExp(TOOL_REQUEST_SITE_PATTERN.source, 'g');
	const sites: ToolRequestSite[] = [];
	let match: RegExpExecArray | null = pattern.exec(source);
	while (match !== null) {
		const open = match.index + match[0].length - 1;
		const argument = callArgument(source, open) ?? '';
		sites.push({
			file,
			line: source.slice(0, match.index).split('\n').length,
			...readToolRequestArgument(argument),
		});
		match = pattern.exec(source);
	}
	return sites;
}

/** The census of {@link toolRequestSitesIn} over every client/tool browser file. */
function censusToolRequestSites(): ToolRequestSite[] {
	return clientJsFiles().flatMap((file) =>
		toolRequestSitesIn(file, readFileSync(join(REPO_ROOT, file), 'utf8')),
	);
}

/**
 * The OTHER ways a tool's browser code reaches `dd_tools_api / tool_request`
 * than a `tool_request(` call. None of them can be read the way a call can, so
 * a tool that declares a read-only action is not allowed to use them:
 *
 *  - `hand_built_body`    — it spells the request body itself (`dd_api:
 *                           'dd_tools_api'` or `action: 'tool_request'`, the v6
 *                           shape: `create_source(self, 'name')` into a `rqo`
 *                           handed to `data_manager.request`). The transport
 *                           default (5 attempts, stamped) applies unless that
 *                           call spells `retries: 1`, and which request a body
 *                           reaches is a data flow the census does not follow.
 *  - `create_source`      — `create_source(x, '<action>')`, the source of such a
 *                           body, naming the action as a literal. Only an offender
 *                           when the action IS one the server declares read-only.
 *  - `forwarder_reference`— `x.tool_request` used as a VALUE (`.call`, `.apply`,
 *                           `.bind`, an alias in a variable): the argument of the
 *                           eventual call is not where the census looks. The
 *                           prototype alias every tool declares
 *                           (`tool_x.prototype.tool_request = tool_common.prototype.
 *                           tool_request`) is wiring, not a use, and is not a hit.
 */
interface ToolRequestSpelling {
	file: string;
	line: number;
	kind: 'hand_built_body' | 'create_source' | 'forwarder_reference';
	/** The literal action of a `create_source` hit, else null. */
	action: string | null;
}

/** `dd_api: 'dd_tools_api'` or `action: 'tool_request'`: a request body written out by hand. */
const HAND_BUILT_BODY_PATTERN =
	/\b(?:dd_api\s*:\s*['"`]dd_tools_api['"`]|action\s*:\s*['"`]tool_request['"`])/g;

/**
 * A property access to `tool_request` that is not an immediate call. The dot sits
 * against the name (a formatter breaks the line BEFORE the dot, never after it),
 * so a sentence in a message string ("Error. tool_request: missing") is not one.
 */
const FORWARDER_REFERENCE_PATTERN = /\.tool_request\b(?!\s*\()/g;

/** The wiring line every tool carries; it names the forwarder without using it. */
const FORWARDER_ALIAS_PATTERN =
	/^[ \t]*[\w$.]+\.prototype\.tool_request\s*=\s*tool_common\.prototype\.tool_request[ \t]*;?[ \t]*$/gm;

/** Every hand-built / indirect spelling of the tool_request door in a source text. */
function toolRequestSpellingsIn(file: string, raw: string): ToolRequestSpelling[] {
	const source = stripComments(raw);
	const lineOf = (index: number): number => source.slice(0, index).split('\n').length;
	const spellings: ToolRequestSpelling[] = [];
	for (const match of source.matchAll(HAND_BUILT_BODY_PATTERN)) {
		spellings.push({ file, line: lineOf(match.index), kind: 'hand_built_body', action: null });
	}
	// the alias statements are wiring: blank them (offsets kept) before looking for references
	const unwired = source.replace(FORWARDER_ALIAS_PATTERN, (line) => line.replace(/[^\n]/g, ' '));
	for (const match of unwired.matchAll(FORWARDER_REFERENCE_PATTERN)) {
		spellings.push({ file, line: lineOf(match.index), kind: 'forwarder_reference', action: null });
	}
	for (const match of source.matchAll(/\bcreate_source\s*\(/g)) {
		const open = match.index + match[0].length - 1;
		const second = splitTopLevel(callArgument(source, open) ?? '')[1] ?? '';
		const action = /^(['"`])([A-Za-z0-9_]+)\1$/.exec(second)?.[2] ?? null;
		spellings.push({ file, line: lineOf(match.index), kind: 'create_source', action });
	}
	return spellings;
}

/** The census of {@link toolRequestSpellingsIn} over every client/tool browser file. */
function censusToolRequestSpellings(): ToolRequestSpelling[] {
	return clientJsFiles().flatMap((file) =>
		toolRequestSpellingsIn(file, readFileSync(join(REPO_ROOT, file), 'utf8')),
	);
}

/**
 * The browser code of a tool that declares readOnly actions which breaks the
 * "a read-only action is called once" rule, as sentences. THE judge: the real
 * census and the injected controls both go through it.
 *
 * A read-only action is never ledgered, so the transport's resend of a stalled
 * call RE-EXECUTES it: for a third-party lookup that is up to five upstream calls
 * per click, where the ledger used to make it one. The tool's client therefore
 * reaches the server ONLY through `self.tool_request({ ... })`, and a call of a
 * read-only action passes the literal `retries: 1` (no resend, no key):
 *
 *  - a `tool_request(` call whose own `retries` is the literal 1 is safe whatever
 *    its action is — no key, no resend (a generic `tool_request({ action,
 *    options, retries: 1 })` helper is legitimate);
 *  - any other call must spell its action as a literal, and then `retries: 1`
 *    only if the action is one the server declares read-only. A call that spells
 *    neither is unreadable, and an unreadable call is no proof;
 *  - a hand-built request body, `create_source` naming a read-only action, or a
 *    use of the forwarder as a value (ToolRequestSpelling) is an offender in
 *    such a tool: the census cannot read where it ends up.
 *
 * A site belongs to the tool its file lives in (`tools/<tool>/js/...`), because
 * `tool_request` addresses the instance's own model. NOT COVERED (stated, not
 * gated): a read-only action requested from ANOTHER tool's code or from `client/`
 * by an inline `source: { model: 'tool_x', action }`; its declared tool is not
 * the file's tool, and the census would have to follow the model through data.
 */
function readOnlyCallSiteOffenders(
	sites: readonly ToolRequestSite[],
	readOnlyActions: ReadonlyMap<string, ReadonlySet<string>>,
	spellings: readonly ToolRequestSpelling[] = [],
): string[] {
	const offenders: string[] = [];
	const declaredOf = (file: string): { tool: string; declared: ReadonlySet<string> } | null => {
		const tool = /^tools\/([^/]+)\//.exec(file)?.[1];
		const declared = tool === undefined ? undefined : readOnlyActions.get(tool);
		return tool === undefined || declared === undefined || declared.size === 0
			? null
			: { tool, declared };
	};
	for (const site of sites) {
		const owner = declaredOf(site.file);
		if (owner === null || site.retries === '1') continue;
		const where = `${site.file}:${site.line}`;
		if (site.action === null) {
			offenders.push(
				`${where}: ${owner.tool} declares readOnly actions, but this tool_request call spells neither a literal \`action: 'name'\` nor the literal \`retries: 1\` — the census cannot tell whether it calls one (found retries: ${site.retries ?? 'none'})`,
			);
		} else if (owner.declared.has(site.action)) {
			offenders.push(
				`${where}: \`${site.action}\` is readOnly on the server (never ledgered) — pass the literal \`retries: 1\` (found: ${site.retries ?? 'none'})`,
			);
		}
	}
	for (const spelling of spellings) {
		const owner = declaredOf(spelling.file);
		if (owner === null) continue;
		const where = `${spelling.file}:${spelling.line}`;
		const actions = [...owner.declared].join(', ');
		if (spelling.kind === 'create_source') {
			if (spelling.action !== null && owner.declared.has(spelling.action)) {
				offenders.push(
					`${where}: \`${spelling.action}\` is readOnly on the server, but this code builds its request source by hand (create_source) — send it through \`self.tool_request({ action: '${spelling.action}', options, retries: 1 })\``,
				);
			}
		} else {
			const what =
				spelling.kind === 'hand_built_body'
					? 'writes a dd_tools_api / tool_request body by hand'
					: 'uses tool_request as a value (.call / .apply / .bind / an alias)';
			offenders.push(
				`${where}: ${owner.tool} declares readOnly actions (${actions}), but this code ${what} — the census cannot read which action it reaches or its retries, and the transport default (5 stamped attempts) would re-execute a read-only action up to five times. Send every request of this tool through \`self.tool_request({ action, options, retries })\`.`,
			);
		}
	}
	return offenders;
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

	/**
	 * THE ONE FORWARDER. `tool_common.prototype.tool_request` hands the CALLER's
	 * `retries` to data_manager.request, so its own `data_manager.request` site
	 * carries no literal for the census above to read (the options ride in a
	 * spread). That is safe only while every property below holds, and they are
	 * asserted, not trusted:
	 *  - the wrapper is DEFINED exactly once, in tool_common.js (every other tool
	 *    file only aliases it), so no second forwarder escapes this block;
	 *  - it adds each transport option ONLY when the caller gave a usable one. An
	 *    explicit `retries: undefined` would OVERRIDE the transport's default of 5
	 *    (`{...default_options, ...options}`); before data_manager normalised the
	 *    count that was FIVE UNSTAMPED attempts (the stamp asked `retries > 1`, the
	 *    retry loop clamped `retries ?? 5`) — a write resent blind, CLI-01 — and a
	 *    NaN was zero attempts. The bare spelling `retries: options.retries` is
	 *    exactly that. The transport half is block D; the forwarder passes only an
	 *    integer >= 1 so a caller bug does not rest on that line alone;
	 *  - every `tool_request(` call site passes a LITERAL `retries` or none;
	 *  - in a tool that declares a `readOnly` action (derived from the loaded tool
	 *    modules), the read-only call-site rule below: calls are read at depth 0, a
	 *    call of a read-only action passes the literal `retries: 1`, and the other
	 *    spellings of the door (hand-built body, `create_source` of a read-only
	 *    action, the forwarder used as a value) are refused.
	 */
	describe('the tool_request forwarder and its callers', () => {
		const forwarderSource = readFileSync(join(REPO_ROOT, TOOL_REQUEST_FORWARDER), 'utf8');
		const DEFINITION = 'tool_common.prototype.tool_request = async function(options) {';

		/** The wrapper's own bytes as a callable, with its two collaborators injected. */
		function forwarder(): (
			this: { model: string },
			options: Record<string, unknown>,
		) => Promise<unknown> {
			const start = forwarderSource.indexOf(DEFINITION);
			const end = forwarderSource.indexOf('}//end tool_request');
			if (start === -1 || end === -1) throw new Error('the tool_request definition moved');
			const expression = forwarderSource.slice(
				start + 'tool_common.prototype.tool_request = '.length,
				end + 1,
			);
			return new Function('data_manager', 'create_source', `return (${expression})`)(
				{
					request: async (requestOptions: Record<string, unknown>) => {
						sent.push(requestOptions);
						return { ok: true };
					},
				},
				(self: { model: string }, action: string) => ({ model: self.model, action }),
			);
		}
		const sent: Array<Record<string, unknown>> = [];

		test('the wrapper is defined once, in tool_common.js; every other file aliases it', () => {
			const defining = clientJsFiles().filter((file) =>
				/\btool_request\s*=\s*(?:async\s+)?function\b/.test(
					stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')),
				),
			);
			expect(defining).toEqual([TOOL_REQUEST_FORWARDER]);
		});

		test('a call that gives no transport option sends NONE — not even a key set to undefined', async () => {
			sent.length = 0;
			await forwarder().call({ model: 'tool_probe' }, { action: 'a', options: {} });
			await forwarder().call(
				{ model: 'tool_probe' },
				{ action: 'a', options: {}, retries: undefined, timeout: undefined },
			);
			expect(sent.length).toBe(2);
			for (const requestOptions of sent) {
				expect(
					Object.keys(requestOptions).sort(),
					'`retries: undefined` in the options would override the transport default of 5',
				).toEqual(['body']);
			}
		});

		test('an UNUSABLE retries (null, NaN, 0, a string, a fraction) is not forwarded either', async () => {
			for (const retries of [null, Number.NaN, 0, -1, '1', 1.5, Number.POSITIVE_INFINITY]) {
				sent.length = 0;
				await forwarder().call({ model: 'tool_probe' }, { action: 'a', options: {}, retries });
				expect(sent.length, String(retries)).toBe(1);
				expect(Object.keys(sent[0] as object).sort(), String(retries)).toEqual(['body']);
			}
		});

		test('a call that gives retries / timeout / busy_notice forwards exactly those', async () => {
			sent.length = 0;
			await forwarder().call(
				{ model: 'tool_probe' },
				{ action: 'lookup', options: { q: 1 }, retries: 1, timeout: 20000, busy_notice: false },
			);
			expect(sent.length).toBe(1);
			expect(sent[0]).toMatchObject({ retries: 1, timeout: 20000, busy_notice: false });
			expect(
				(sent[0] as { body: { source: unknown } }).body.source,
				'the source names the tool and the action the server resolves',
			).toEqual({ model: 'tool_probe', action: 'lookup' });
		});

		test('the detector reads a spelled-out retries, a non-literal one and a formatter-split call', () => {
			const spelled = toolRequestSitesIn('x.js', 'self.tool_request({ action: "a", retries: 1 })');
			const dynamic = toolRequestSitesIn('x.js', 'self.tool_request({ action: "a", retries: n })');
			const split = toolRequestSitesIn('x.js', 'self\n\t.tool_request({ action: "a" })');
			expect(spelled.map((site) => site.retries)).toEqual(['1']);
			expect(dynamic.map((site) => site.retries)).toEqual(['n']);
			expect(split.map((site) => site.retries)).toEqual([null]);
		});

		test('the detector reads a literal action, and none for a variable or a spread', () => {
			const literal = toolRequestSitesIn(
				'x.js',
				"self.tool_request({ action: 'lookup', retries: 1, options: { action: 'inner' } })",
			);
			const variable = toolRequestSitesIn('x.js', 'self.tool_request({ action: name })');
			const spread = toolRequestSitesIn('x.js', 'self.tool_request({ ...request })');
			expect(literal.map((site) => site.action)).toEqual(['lookup']);
			expect(variable.map((site) => site.action)).toEqual([null]);
			expect(spread.map((site) => site.action)).toEqual([null]);
		});

		/**
		 * DEPTH 0, IN ORDER. The first draft took the first `retries:` / `action:`
		 * ANYWHERE in the argument text, nested objects included, so a spelling the
		 * transport does not honour satisfied the rule and another call's keys could be
		 * judged instead. The call's own keys are the depth-0 keys of its argument
		 * object, and a later property overrides an earlier one as it does at runtime.
		 */
		test('the detector reads the call’s OWN depth-0 keys: a nested retries or action is not the call’s', () => {
			const read = (argument: string) => {
				const [site] = toolRequestSitesIn('x.js', `self.tool_request(${argument})`);
				return { action: site?.action, retries: site?.retries };
			};
			// a nested `retries` is the action's own option, not a transport count
			expect(read("{ action: 'read_demo', options: { retries: 1 } }")).toEqual({
				action: 'read_demo',
				retries: null,
			});
			// a nested `action` before the call's own is not the call's action
			expect(read("{ options: { action: 'x' }, action: 'read_demo', retries: 1 }")).toEqual({
				action: 'read_demo',
				retries: '1',
			});
			// shorthand: the key is read, the value is an identifier, never a literal
			expect(read('{ action, options, retries: 1 }')).toEqual({ action: null, retries: '1' });
			expect(read("{ action: 'read_demo', retries }")).toEqual({
				action: 'read_demo',
				retries: 'retries',
			});
			// quoted keys, and a string value that holds commas, braces and a fake key
			expect(read("{ 'action': 'read_demo', \"retries\": 1 }")).toEqual({
				action: 'read_demo',
				retries: '1',
			});
			expect(
				read("{ options: { q: 'a, {b', note: \"retries: 9\" }, action: 'read_demo', retries: 1 }"),
			).toEqual({ action: 'read_demo', retries: '1' });
			// a spread AFTER the keys may replace either; BEFORE them, the explicit keys win
			expect(read("{ action: 'read_demo', retries: 1, ...extra }")).toEqual({
				action: null,
				retries: '...',
			});
			expect(read("{ ...extra, action: 'read_demo', retries: 1 }")).toEqual({
				action: 'read_demo',
				retries: '1',
			});
			// a computed key or a method may be any key at all
			expect(read("{ action: 'read_demo', [name]: 1 }")).toEqual({ action: null, retries: '...' });
			// not an object literal: nothing is readable
			expect(read('options')).toEqual({ action: null, retries: '...' });
			// the last duplicate wins, as in the object
			expect(read("{ action: 'a', retries: 5, action: 'read_demo', retries: 1 }")).toEqual({
				action: 'read_demo',
				retries: '1',
			});
		});

		test('the spelling detector finds a hand-built body, a create_source of an action and a forwarder used as a value', () => {
			const kinds = (source: string) =>
				toolRequestSpellingsIn('x.js', source).map((hit) => [hit.kind, hit.action]);
			// the v6 shape: create_source into a hand-written rqo
			expect(
				kinds(
					"const rqo = { dd_api: 'dd_tools_api', action: 'tool_request', source: create_source(self, 'read_demo') }",
				),
			).toEqual([
				['hand_built_body', null],
				['hand_built_body', null],
				['create_source', 'read_demo'],
			]);
			// a variable action is a create_source with no literal
			expect(kinds('const source = create_source(self, name)')).toEqual([['create_source', null]]);
			// the forwarder as a value, in every spelling
			for (const used of [
				'self.tool_request.call(self, { action: "a" })',
				'self.tool_request.bind(self)',
				'self.tool_request.apply(self, [o])',
				'const send = self.tool_request',
				'self\n\t.tool_request\n\t.call(self, o)',
			]) {
				expect(kinds(used), used).toEqual([['forwarder_reference', null]]);
			}
			// NOT a use: a direct call, the prototype alias every tool carries, a comment, a label string
			expect(kinds('self.tool_request({ action: "a", retries: 1 })')).toEqual([]);
			expect(
				kinds('tool_x.prototype.tool_request\t\t= tool_common.prototype.tool_request'),
			).toEqual([]);
			expect(kinds('// self.tool_request.call(self)\n/* dd_api: "dd_tools_api" */')).toEqual([]);
			expect(kinds("console.error('tool_request: missing action')")).toEqual([]);
		});

		test('every tool_request( call site passes a literal retries, or none', () => {
			const sitesFound = censusToolRequestSites();
			// 13 on 2026-11-06 (the acquisition tools, tool_dev_template, tool_export,
			// tool_identify, tool_error_report, tool_sitebuilder). A census that found
			// fewer has gone blind, not found a smaller client.
			expect(sitesFound.length).toBeGreaterThanOrEqual(12);
			const dynamic = sitesFound
				.filter((site) => site.retries !== null && !/^\d+$/.test(site.retries))
				.map((site) => `${site.file}:${site.line} retries: ${site.retries}`);
			expect(
				dynamic,
				'A tool_request caller passing a computed retries. A lookup that calls a third-party service passes `retries: 1` literally; the count is part of the call site, not data.',
			).toEqual([]);
		});

		/**
		 * THE READ-ONLY CALL-SITE RULE (module.ts GatedToolActionSpec.readOnly). The
		 * set of read-only actions is DERIVED from the loaded tool modules, never
		 * listed here. What it checks is stated in readOnlyCallSiteOffenders and in
		 * this file's header (block H): the `tool_request(` calls of a tool that
		 * declares a read-only action, and the spellings of the door it refuses there.
		 * It is a census of source text, not of runtime calls.
		 */
		describe('a readOnly action is called with retries: 1', () => {
			const real = async (): Promise<Map<string, Set<string>>> => {
				const registry = await loadToolModules();
				const declared = new Map<string, Set<string>>();
				for (const [tool, loaded] of registry) {
					const actions = Object.entries(loaded.module.apiActions)
						.filter(([, spec]) => spec.readOnly === true)
						.map(([name]) => name);
					declared.set(tool, new Set(actions));
				}
				return declared;
			};

			test('every call site of a readOnly action of the real corpus passes the literal retries: 1', async () => {
				const declared = await real();
				// the population: the exemplar's read_demo is a real declaration with a real
				// call site, so the rule below is EXECUTED on the real corpus
				expect([...(declared.get('tool_dev_template') ?? [])]).toContain('read_demo');
				const sites = censusToolRequestSites().filter(
					(site) => site.file.startsWith('tools/tool_dev_template/') && site.action === 'read_demo',
				);
				expect(sites.length, 'the exemplar calls read_demo').toBeGreaterThanOrEqual(1);
				expect(
					readOnlyCallSiteOffenders(
						censusToolRequestSites(),
						declared,
						censusToolRequestSpellings(),
					),
				).toEqual([]);
			});

			test('the spelling census is not blind: it sees the hand-built bodies the shipped tools carry', () => {
				// ~20 tools build the body by hand (v6 shape). If the detector stops finding
				// them, the rule below it would pass for the wrong reason.
				const handBuilt = new Set(
					censusToolRequestSpellings()
						.filter((hit) => hit.kind === 'hand_built_body')
						.map((hit) => hit.file),
				);
				expect(handBuilt.size).toBeGreaterThanOrEqual(15);
				for (const file of [
					'tools/tool_lang/js/tool_lang.js',
					'tools/tool_export/js/tool_export.js',
					'tools/tool_time_machine/js/tool_time_machine.js',
				]) {
					expect(handBuilt, `${file} builds its request by hand`).toContain(file);
				}
				// and the wiring alias every tool carries is NOT a hit
				expect(
					censusToolRequestSpellings().filter(
						(hit) => hit.kind === 'forwarder_reference' && hit.file.startsWith('tools/'),
					),
				).toEqual([]);
			});

			test('the judge (positive controls): a default-retries call, a computed one and an unreadable action are offenders', () => {
				const declared = new Map([['tool_zz', new Set(['lookup'])]]);
				const site = (over: Partial<ToolRequestSite>): ToolRequestSite => ({
					file: 'tools/tool_zz/js/tool_zz.js',
					line: 10,
					retries: '1',
					action: 'lookup',
					...over,
				});
				// accepted: the read-only action with the literal 1; another action of the tool; another tool
				expect(readOnlyCallSiteOffenders([site({})], declared)).toEqual([]);
				expect(
					readOnlyCallSiteOffenders([site({ action: 'save', retries: null })], declared),
				).toEqual([]);
				expect(
					readOnlyCallSiteOffenders(
						[site({ file: 'tools/tool_other/js/x.js', retries: null })],
						declared,
					),
				).toEqual([]);
				// a call whose own retries is the literal 1 is safe WHATEVER its action is (no key, no
				// resend): the generic `tool_request({ action, options, retries: 1 })` helper shape
				expect(readOnlyCallSiteOffenders([site({ action: null, retries: '1' })], declared)).toEqual(
					[],
				);
				// refused
				expect(readOnlyCallSiteOffenders([site({ retries: null })], declared)).toHaveLength(1);
				expect(readOnlyCallSiteOffenders([site({ retries: '5' })], declared)).toHaveLength(1);
				expect(readOnlyCallSiteOffenders([site({ retries: 'n' })], declared)).toHaveLength(1);
				expect(readOnlyCallSiteOffenders([site({ retries: '...' })], declared)).toHaveLength(1);
				// an unreadable action is an offender unless the retries is the literal 1
				expect(
					readOnlyCallSiteOffenders([site({ action: null, retries: null })], declared),
				).toHaveLength(1);
				expect(
					readOnlyCallSiteOffenders([site({ action: null, retries: '5' })], declared),
				).toHaveLength(1);
				expect(
					readOnlyCallSiteOffenders([site({ action: null, retries: '...' })], declared),
				).toHaveLength(1);
			});

			test('the judge (positive controls): a hand-built body or a forwarder used as a value in a tool with a read-only action is an offender', () => {
				const declared = new Map([
					['tool_zz', new Set(['lookup'])],
					['tool_plain', new Set<string>()],
				]);
				const spelling = (over: Partial<ToolRequestSpelling>): ToolRequestSpelling => ({
					file: 'tools/tool_zz/js/tool_zz.js',
					line: 7,
					kind: 'hand_built_body',
					action: null,
					...over,
				});
				const judge = (hit: ToolRequestSpelling) => readOnlyCallSiteOffenders([], declared, [hit]);
				// refused in a tool that declares a read-only action
				expect(judge(spelling({}))).toHaveLength(1);
				expect(judge(spelling({ kind: 'forwarder_reference' }))).toHaveLength(1);
				expect(judge(spelling({ kind: 'create_source', action: 'lookup' }))).toHaveLength(1);
				// the offender names the file, the line and the tool's read-only actions
				expect(judge(spelling({}))[0]).toContain('tools/tool_zz/js/tool_zz.js:7');
				expect(judge(spelling({}))[0]).toContain('lookup');
				// a create_source for an action that is NOT read-only is another action's business
				expect(judge(spelling({ kind: 'create_source', action: 'save' }))).toEqual([]);
				expect(judge(spelling({ kind: 'create_source', action: null }))).toEqual([]);
				// a tool that declares nothing read-only may build its bodies however it likes
				expect(judge(spelling({ file: 'tools/tool_plain/js/x.js' }))).toEqual([]);
				expect(judge(spelling({ file: 'tools/tool_unknown/js/x.js' }))).toEqual([]);
				expect(judge(spelling({ file: 'client/dedalo/core/x.js' }))).toEqual([]);
			});

			test('end to end on source text: the v6 spelling of a read-only action is caught, the forwarder spelling is not', () => {
				const declared = new Map([['tool_zz', new Set(['lookup'])]]);
				const file = 'tools/tool_zz/js/tool_zz.js';
				const judge = (source: string) =>
					readOnlyCallSiteOffenders(
						toolRequestSitesIn(file, source),
						declared,
						toolRequestSpellingsIn(file, source),
					);
				const v6 = [
					"const source = create_source(self, 'lookup')",
					"const rqo = { dd_api: 'dd_tools_api', action: 'tool_request', source, options: {} }",
					'return data_manager.request({ body: rqo })',
				].join('\n');
				// three hits: the body (two spellings of it) and the create_source of the read-only action
				expect(judge(v6).length).toBeGreaterThanOrEqual(2);
				// even with retries: 1 on the request, the body is hand-built: unreadable, refused
				expect(
					judge(v6.replace('{ body: rqo }', '{ body: rqo, retries: 1 }')).length,
				).toBeGreaterThan(0);
				expect(
					judge("self.tool_request.call(self, { action: 'lookup', retries: 1 })"),
				).toHaveLength(1);
				// the accepted spellings
				expect(judge("self.tool_request({ action: 'lookup', options: {}, retries: 1 })")).toEqual(
					[],
				);
				expect(judge('self.tool_request({ action, options, retries: 1 })')).toEqual([]);
				expect(judge("self.tool_request({ action: 'save', options: {} })")).toEqual([]);
				// a nested retries does not satisfy the rule
				expect(
					judge("self.tool_request({ action: 'lookup', options: { retries: 1 } })"),
				).toHaveLength(1);
			});
		});
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

	/**
	 * THE STAMP AND THE RESEND COUNT READ ONE VALUE. `{...defaults, ...options}` lets
	 * a key present with the value `undefined` / `null` override the default, and the
	 * stamp (`retries > 1`) and the retry loop (`Math.max(1, retries ?? 5)`) used to
	 * read it differently: five byte-identical attempts, NO key — a write resent
	 * blind (CLI-01). A NaN was zero attempts. Each unusable value is now the
	 * DEFAULT: five attempts, one key.
	 */
	test('an UNUSABLE retries (undefined, null, NaN, a string, Infinity) is the default: five attempts, ONE key', async () => {
		for (const retries of [undefined, null, Number.NaN, 'x', Number.POSITIVE_INFINITY]) {
			posted = [];
			await dataManager.request({
				body: { action: 'create', dd_api: 'dd_core_api' },
				retries,
				timeout: 20,
				base_delay: 1,
			});
			expect(posted.length, `retries: ${String(retries)} must not skip the retry loop`).toBe(5);
			expect(new Set(posted.map((entry) => entry.body)).size, String(retries)).toBe(1);
			const key = JSON.parse(posted[0]?.body as string).idempotency_key as string;
			expect(key, `retries: ${String(retries)} — five attempts WITHOUT a key is CLI-01`).toMatch(
				/^[A-Za-z0-9_-]{16,128}$/,
			);
		}
	}, 30000);

	test('a retries of 0 or a fraction is clamped: 0 sends once with no key, 2.9 sends twice with one', async () => {
		posted = [];
		await dataManager.request({
			body: { action: 'save', dd_api: 'dd_core_api' },
			retries: 0,
			timeout: 20,
			base_delay: 1,
		});
		expect(posted.length).toBe(1);
		expect(JSON.parse(posted[0]?.body as string).idempotency_key).toBeUndefined();

		posted = [];
		await dataManager.request({
			body: { action: 'save', dd_api: 'dd_core_api' },
			retries: 2.9,
			timeout: 20,
			base_delay: 1,
		});
		expect(posted.length).toBe(2);
		const keys = posted.map((entry) => JSON.parse(entry.body as string).idempotency_key);
		expect(new Set(keys).size).toBe(1);
		expect(keys[0]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
	}, 30000);

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

/** A context for an authenticated session of `userId` (not a global admin). */
function contextOf(userId: number): ApiRequestContext {
	const token = createSession(userId, `zz_idem_${userId}`, false);
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
// H — tool_request is classified by the NESTED action
// ---------------------------------------------------------------------------

/**
 * Scratch actions on two REAL loaded tool modules (the pattern of
 * tool_request.test.ts: gates 3-6 pass for real, the scratch keys are removed in
 * afterAll). Each probe counts its runs and records whether it ran inside the
 * read-only request scope, so every case below asserts what the HANDLER saw —
 * not only what the ledger holds.
 */
describe('H — a tool action that declares readOnly is not ledgered', () => {
	const TOOL_A = 'tool_export';
	const TOOL_B = 'tool_time_machine';
	const READ = 'zz_idem_read';
	const DEFAULT_ACTION = 'zz_idem_default';
	const THROW_READ = 'zz_idem_throw_read';
	const THROW_DEFAULT = 'zz_idem_throw_default';
	const TRY_WRITE = 'zz_idem_try_write';
	const LOOKUP_THROWS = 'zz_idem_lookup_throws';
	const SCRATCH_A = [READ, DEFAULT_ACTION, THROW_READ, THROW_DEFAULT, TRY_WRITE, LOOKUP_THROWS];
	/** A user that exists nowhere: its profile grants no tool (asserted below, not assumed). */
	const UNGRANTED_USER = 2_147_000_001;

	let runs: Record<string, number> = {};
	let scope: Record<string, boolean> = {};
	const actionsOf: Record<string, Record<string, ToolActionSpec>> = {};

	const UNGATED = 'UNGATED — a scratch probe of the idempotency gate, never shipped';

	/** A scratch action. `permission: null` is the named exemption: no gate stands in the way of the probe. */
	function probe(
		name: string,
		readOnly: boolean,
		body: () => Promise<ReturnType<typeof ok>>,
	): ToolActionSpec {
		const handler = async () => {
			runs[name] = (runs[name] ?? 0) + 1;
			scope[name] = inReadOnlyScope();
			return body();
		};
		return readOnly
			? { permission: null, gatedInHandler: UNGATED, readOnly: true, handler }
			: { permission: null, gatedInHandler: UNGATED, handler };
	}

	const answer = async () => ok({ probe: true }, { requestId: 'zz-idem-h' });
	const upstreamFailure = async (): Promise<ReturnType<typeof ok>> => {
		throw new DedaloError('external.http_status', { message: 'upstream answered 503' });
	};

	beforeAll(async () => {
		const toolA = await getLoadedTool(TOOL_A);
		const toolB = await getLoadedTool(TOOL_B);
		if (toolA === undefined || toolB === undefined) throw new Error('probe tools are not loaded');
		actionsOf[TOOL_A] = toolA.module.apiActions;
		actionsOf[TOOL_B] = toolB.module.apiActions;
		const a = actionsOf[TOOL_A] as Record<string, ToolActionSpec>;
		a[READ] = probe(READ, true, answer);
		a[DEFAULT_ACTION] = probe(DEFAULT_ACTION, false, answer);
		a[THROW_READ] = probe(THROW_READ, true, upstreamFailure);
		a[THROW_DEFAULT] = probe(THROW_DEFAULT, false, upstreamFailure);
		a[TRY_WRITE] = probe(TRY_WRITE, true, async () => {
			// A declared-read action that reaches a record write door. Were the scope
			// not in force this would INSERT a record on the suite table.
			const created = await insertMatrixRecordWithCounter(TABLE, SECTION, {});
			minted.push(created);
			return ok({ created }, { requestId: 'zz-idem-h' });
		});
		// the SAME name as the read-only probe, on a DIFFERENT tool, declaring nothing
		(actionsOf[TOOL_B] as Record<string, ToolActionSpec>)[READ] = probe(READ, false, answer);
		// the action whose readOnly LOOKUP the fail-safe test makes throw
		a[LOOKUP_THROWS] = probe(LOOKUP_THROWS, false, answer);
	});

	afterAll(() => {
		for (const name of SCRATCH_A) Reflect.deleteProperty(actionsOf[TOOL_A] ?? {}, name);
		Reflect.deleteProperty(actionsOf[TOOL_B] ?? {}, READ);
		resetIdempotencyLedgerForTests();
	});

	function reset(): void {
		resetIdempotencyLedgerForTests();
		runs = {};
		scope = {};
	}

	/** A tool_request through the REAL parse door and the REAL dispatcher, as root (or as `asUser`). */
	async function dispatchTool(
		tool: string,
		action: string,
		key: string | null,
		options: Record<string, unknown> = {},
		ctx?: ApiRequestContext,
		asUser: number = USER_ID,
	): Promise<ApiResult> {
		const rqo: Record<string, unknown> = {
			dd_api: 'dd_tools_api',
			action: 'tool_request',
			source: { model: tool, action },
			options,
		};
		if (key !== null) rqo.idempotency_key = key;
		const context_ = ctx ?? (asUser === USER_ID ? context() : contextOf(asUser));
		context_.principal = await resolvePrincipal(asUser);
		return dispatchRqo(rqoSchema.parse(JSON.parse(JSON.stringify(rqo))), context_);
	}

	const codeOf = (result: ApiResult): string | undefined =>
		(result.body as { error?: { code?: string } }).error?.code;
	const okOf = (result: ApiResult): unknown => (result.body as { ok?: unknown }).ok;

	test('the static row stays `mutating` — the refinement is per request, not a map entry', () => {
		expect(ACTION_IDEMPOTENCY.get('dd_tools_api:tool_request')).toBe('mutating');
		// and the sync seam still ledgers a keyed tool_request: the nested check is
		// the async step in withIdempotency, not a change to the key derivation
		const ctx = context();
		expect(
			idempotencyLedgerKey(
				{ dd_api: 'dd_tools_api', action: 'tool_request', idempotency_key: KEY_A } as Rqo,
				ctx,
				'dd_tools_api:tool_request',
			),
		).not.toBeNull();
	});

	test('a readOnly action: the same key twice EXECUTES TWICE and the ledger stays empty', async () => {
		reset();
		const first = await dispatchTool(TOOL_A, READ, KEY_A);
		const second = await dispatchTool(TOOL_A, READ, KEY_A);
		expect(okOf(first)).toBe(true);
		expect(okOf(second)).toBe(true);
		expect(runs[READ], 'a resend of a read-only action re-executes').toBe(2);
		expect(idempotencyLedgerStats().entries).toBe(0);
		expect((second.body as Record<string, unknown>).idempotent_replay).toBeUndefined();
	}, 60000);

	test('POSITIVE CONTROL: the same action WITHOUT the declaration executes once and replays', async () => {
		reset();
		const first = await dispatchTool(TOOL_A, DEFAULT_ACTION, KEY_A);
		const second = await dispatchTool(TOOL_A, DEFAULT_ACTION, KEY_A);
		expect(okOf(first)).toBe(true);
		expect(runs[DEFAULT_ACTION], 'the undeclared default is the ledgered one').toBe(1);
		expect(idempotencyLedgerStats().entries).toBe(1);
		expect((second.body as Record<string, unknown>).idempotent_replay).toBe(true);
	}, 60000);

	test('the handler runs inside the read-only scope iff it declares readOnly', async () => {
		reset();
		await dispatchTool(TOOL_A, READ, KEY_A);
		await dispatchTool(TOOL_A, DEFAULT_ACTION, KEY_B);
		expect(scope[READ], 'the declared-read handler must run where every write door refuses').toBe(
			true,
		);
		expect(scope[DEFAULT_ACTION], 'an ordinary action must not run under the read-only scope').toBe(
			false,
		);
		// and the scope is LEFT behind: this test body is outside it
		expect(inReadOnlyScope()).toBe(false);
	}, 60000);

	/**
	 * THE REGRESSION THIS WAS BUILT FOR. The acquisition tools throw
	 * `external.http_status` (retryable, 503) from tool_request. With the action
	 * ledgered, the leader's throw leaves an `ambiguous` reservation, the browser
	 * transport retries the retryable 503 under the SAME key, and the resend is
	 * answered `idempotency.outcome_unknown` (409) — the real upstream error is
	 * gone from the screen. A declared read-only action must surface the real
	 * error on every attempt.
	 */
	test('REGRESSION: a read-only action that throws external.http_status surfaces the REAL error on the resend', async () => {
		reset();
		const first = await dispatchTool(TOOL_A, THROW_READ, KEY_A);
		const second = await dispatchTool(TOOL_A, THROW_READ, KEY_A);
		expect(codeOf(first)).toBe('external.http_status');
		expect(codeOf(second), 'the resend must see the real error, not an ambiguity').toBe(
			'external.http_status',
		);
		expect(second.status).toBe(503);
		expect(runs[THROW_READ]).toBe(2);
		expect(idempotencyLedgerStats().entries, 'a throw leaves NO ambiguous reservation').toBe(0);
	}, 60000);

	test('CONTROL: the same throw from an undeclared action IS masked by idempotency.outcome_unknown', async () => {
		reset();
		const first = await dispatchTool(TOOL_A, THROW_DEFAULT, KEY_A);
		const second = await dispatchTool(TOOL_A, THROW_DEFAULT, KEY_A);
		expect(codeOf(first)).toBe('external.http_status');
		expect(codeOf(second)).toBe('idempotency.outcome_unknown');
		expect(second.status).toBe(409);
		expect(
			(second.body as { error?: { details?: Record<string, unknown> } }).error?.details
				?.original_error_code,
		).toBe('external.http_status');
		expect(runs[THROW_DEFAULT], 'and the resend was never executed').toBe(1);
		expect(idempotencyLedgerStats().entries).toBe(1);
	}, 60000);

	test('a read-only action cannot write: the door refuses it as internal.invariant and nothing lands', async () => {
		reset();
		const before = await recordCount();
		const result = await dispatchTool(TOOL_A, TRY_WRITE, KEY_A);
		expect(okOf(result)).toBe(false);
		expect(codeOf(result)).toBe('internal.invariant');
		expect(await recordCount(), 'the refused write must not have inserted a record').toBe(before);
		expect(runs[TRY_WRITE]).toBe(1);
		expect(idempotencyLedgerStats().entries).toBe(0);
	}, 60000);

	test('a flag the CLIENT merely claims changes nothing: classification comes from the module', async () => {
		reset();
		const claim = { read_only: true, readOnly: true, idempotent: true };
		await dispatchTool(TOOL_A, DEFAULT_ACTION, KEY_A, claim);
		const again = await dispatchTool(TOOL_A, DEFAULT_ACTION, KEY_A, claim);
		expect(runs[DEFAULT_ACTION]).toBe(1);
		expect((again.body as Record<string, unknown>).idempotent_replay).toBe(true);
		expect(idempotencyLedgerStats().entries).toBe(1);
	}, 60000);

	test('the classification is per (tool, action): the same action NAME on another tool is ledgered', async () => {
		reset();
		await dispatchTool(TOOL_A, READ, KEY_A);
		expect(idempotencyLedgerStats().entries, 'tool A declares it read-only').toBe(0);
		await dispatchTool(TOOL_B, READ, KEY_B);
		await dispatchTool(TOOL_B, READ, KEY_B);
		expect(idempotencyLedgerStats().entries, 'tool B, same name, declares nothing').toBe(1);
		expect(runs[READ], 'one run on A and one on B — B replayed').toBe(2);
	}, 60000);

	test('every doubt is ledgered: unknown tool, unknown action, a background request', async () => {
		reset();
		const unknownTool = await dispatchTool('tool_zz_not_a_tool', READ, KEY_A);
		expect(codeOf(unknownTool)).toBe('tool.invalid_name');
		expect(idempotencyLedgerStats().entries).toBe(1);

		const unknownAction = await dispatchTool(TOOL_A, 'zz_idem_no_such_action', KEY_B);
		expect(codeOf(unknownAction)).toBe('tool.method_not_allowed');
		expect(idempotencyLedgerStats().entries).toBe(2);

		// scheduling a job is a write: a readOnly action asked to run in the background
		// is ledgered AND refused (the loader also refuses readOnly + backgroundRunnable)
		const background = await dispatchTool(TOOL_A, READ, KEY_C, { background_running: true });
		expect(codeOf(background)).toBe('tool.background_not_allowed');
		expect(idempotencyLedgerStats().entries).toBe(3);
		expect(runs[READ], 'the refused background request never reached the handler').toBeUndefined();
	}, 60000);

	test('the reserved job-status / jobs framework actions are read-only: never ledgered', async () => {
		reset();
		for (const action of [BACKGROUND_JOB_STATUS_ACTION, BACKGROUND_JOBS_ACTION]) {
			await dispatchTool(TOOL_A, action, KEY_A, { job_id: 'zz_no_such_job' });
			await dispatchTool(TOOL_A, action, KEY_A, { job_id: 'zz_no_such_job' });
		}
		expect(idempotencyLedgerStats().entries).toBe(0);
	}, 60000);

	test('the classifier fails SAFE on malformed input (every doubt answers false)', async () => {
		for (const [source, options] of [
			[{ model: TOOL_A, action: READ }, 'not-an-object'],
			[{ model: TOOL_A, action: READ }, null],
			[{ model: 'not a tool name', action: READ }, {}],
			[{ model: 42, action: READ }, {}],
			[{ model: TOOL_A, action: 42 }, {}],
			[{ model: TOOL_A, action: 'constructor' }, {}],
			[{ model: TOOL_A, action: '__proto__' }, {}],
			[undefined, {}],
		] as Array<[{ model?: unknown; action?: unknown } | undefined, unknown]>) {
			expect(
				await isReadOnlyToolRequest(USER_ID, source, options),
				JSON.stringify([source, options]),
			).toBe(false);
		}
		// and the positive: the declared pair, with options absent or an object
		expect(await isReadOnlyToolRequest(USER_ID, { model: TOOL_A, action: READ }, undefined)).toBe(
			true,
		);
		expect(await isReadOnlyToolRequest(USER_ID, { model: TOOL_A, action: READ }, {})).toBe(true);
		expect(
			await isReadOnlyToolRequest(
				USER_ID,
				{ model: TOOL_A, action: READ },
				{ background_running: true },
			),
		).toBe(false);
	});

	/**
	 * THE FAIL-SAFE CATCH, REACHED. `isReadOnlyToolRequest` answers false when its
	 * lookup throws ("every doubt answers false": classification only ever REMOVES
	 * a request from the ledger). The malformed-input cases above never reach the
	 * catch — they return before the try body can throw — so this one makes the
	 * lookup itself throw: the action's `readOnly` getter, read by the classifier,
	 * throws once. Fail-OPEN (`catch { return true }`) un-ledgers a doubt: the
	 * handler would run twice here.
	 */
	test('a classifier whose lookup THROWS fails SAFE: false, and the request stays ledgered', async () => {
		reset();
		const spec = (actionsOf[TOOL_A] as Record<string, ToolActionSpec>)[LOOKUP_THROWS] as object;
		let armed = true;
		Object.defineProperty(spec, 'readOnly', {
			configurable: true,
			get() {
				if (!armed) return undefined;
				armed = false; // only the classification throws; the handler path reads a normal spec
				throw new Error('zz: the readOnly lookup throws');
			},
		});
		try {
			const source = { model: TOOL_A, action: LOOKUP_THROWS };
			expect(await isReadOnlyToolRequest(USER_ID, source, {})).toBe(false);
			expect(armed, 'the lookup really threw (the getter was consumed)').toBe(false);

			armed = true;
			const first = await dispatchTool(TOOL_A, LOOKUP_THROWS, KEY_A);
			const second = await dispatchTool(TOOL_A, LOOKUP_THROWS, KEY_A);
			expect(armed, 'the dispatch classification consumed the throwing getter').toBe(false);
			expect(okOf(first)).toBe(true);
			expect(runs[LOOKUP_THROWS], 'a doubt is ledgered: the resend is a replay').toBe(1);
			expect(idempotencyLedgerStats().entries).toBe(1);
			expect((second.body as Record<string, unknown>).idempotent_replay).toBe(true);
		} finally {
			Reflect.deleteProperty(spec, 'readOnly');
		}
	}, 60000);

	/**
	 * NO EXISTENCE ORACLE. Classification runs BEFORE the tool-grant gate, and its
	 * answer is observable: a read-only request is not ledgered, so the second send
	 * of a keyed request gives `tool.not_authorized` again, while a ledgered one
	 * gives `idempotency.outcome_unknown` (the leader's throw left an ambiguous
	 * reservation). Answered without the caller, that told a user the tool is NOT
	 * granted to which tools and actions exist and which declare readOnly. The
	 * grant is asked first now: an ungranted caller sees ONE sequence whatever they
	 * name.
	 */
	test('an UNGRANTED caller sees one sequence whatever they name: no readOnly / existence oracle', async () => {
		// the premise, measured: the stand-in user holds none of these tools, root holds them
		expect(await isToolGranted(UNGRANTED_USER, TOOL_A)).toBe(false);
		expect(await isToolGranted(USER_ID, TOOL_A)).toBe(true);

		const pairs: Array<[string, string]> = [
			[TOOL_A, READ], // declares readOnly
			[TOOL_A, DEFAULT_ACTION], // a real mutating action
			[TOOL_A, 'zz_idem_no_such_action'], // an unknown action of a real tool
			['tool_zz_not_a_tool', READ], // an unknown tool
			[TOOL_A, BACKGROUND_JOB_STATUS_ACTION], // a framework job action (read-only for a granted caller)
		];
		const sequences: string[] = [];
		for (const [tool, action] of pairs) {
			reset();
			const first = await dispatchTool(tool, action, KEY_A, {}, undefined, UNGRANTED_USER);
			const second = await dispatchTool(tool, action, KEY_A, {}, undefined, UNGRANTED_USER);
			expect(
				Object.keys(runs),
				`${tool}.${action}: no handler may run for an ungranted caller`,
			).toEqual([]);
			sequences.push(JSON.stringify([codeOf(first), first.status, codeOf(second), second.status]));
			// the classifier itself, for this very caller: never read-only
			expect(
				await isReadOnlyToolRequest(UNGRANTED_USER, { model: tool, action }, {}),
				`${tool}.${action}`,
			).toBe(false);
		}
		expect(new Set(sequences).size, `the sequences differ: ${sequences.join(' | ')}`).toBe(1);
		expect(JSON.parse(sequences[0] as string)[0]).toBe('tool.not_authorized');

		// and the contrast that makes it a measurement: the GRANTED caller does get read-only
		expect(await isReadOnlyToolRequest(USER_ID, { model: TOOL_A, action: READ }, {})).toBe(true);
	}, 60000);

	test('an UNAUTHENTICATED tool_request is refused and never ledgered', async () => {
		reset();
		const anon = { ...context(), session: null } as ApiRequestContext;
		const result = await dispatchTool(TOOL_A, DEFAULT_ACTION, KEY_A, {}, anon);
		expect(codeOf(result)).toBe('auth.not_logged');
		expect(idempotencyLedgerStats().entries).toBe(0);
		expect(runs[DEFAULT_ACTION]).toBeUndefined();
	}, 60000);
});

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
