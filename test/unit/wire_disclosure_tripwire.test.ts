/**
 * TRIPWIRE — no raw exception text on the wire, no record coordinates the
 * caller may not see, and no SILENT debug switch (P2-8 / SEC-16, SEC-17,
 * SEC-18, SEC-19 — the register's numbering: SEC-16 bulk_revert, SEC-17
 * upload, SEC-18 identify + vision, SEC-19 debug switch).
 *
 * The disclosure ladder is a property of `toErrorBody` and NOTHING ELSE. Five
 * doors went around it:
 *
 *  - `bulk_revert`'s `skipped[]` (SEC-16) echoed `permissions_denied:
 *    <section_tipo>/<tipo>#<section_id>` for every batch row OUTSIDE the
 *    caller's scope — the batch row set comes from a TM search with no
 *    projects filter and the bulk id is a small enumerable integer, so a
 *    level-2 holder on any section could enumerate other projects' records —
 *    and pushed the raw `(error as Error).message` (Postgres/fs text) for any
 *    row, from a catch that also wrapped the scope gate. Now: typed entries
 *    `{reason, section_tipo?, tipo?, section_id?}`, coordinates only past the
 *    gate (`inScope`), words to the log with the request id
 *    (WC-2026-09-03-bulk-revert-skipped-typed-entries).
 *  - `vision.ts` (SEC-18's third site) built `declined.detail` from the
 *    provider exception; it reaches an ok:true payload verbatim through
 *    dd_identify_api's `detail: report.declined.detail`, at read level 1.
 *  - `rejectedUpload()` assigned `error.message` to `publicMessage` — a wire
 *    field — under a public-disclosure code, while its own header said the
 *    intent was "the validator's own sentence … never a raw exception string".
 *    The try it serves wraps untried mkdirSync / writeFileSync / renameSync,
 *    whose messages embed ABSOLUTE PATHS, and authorization at that door is
 *    session-only: a consultation-only account reaches it.
 *  - Two identify sites emitted `detail: error.message` inside `ok:true`
 *    payloads, where the ladder does not reach at all and the text is Postgres
 *    or filesystem output.
 *  - `DEDALO_DEBUG_API_ERRORS` collapses the WHOLE ladder — `{exception, stack,
 *    coordinates, cause_chain}` on every failure body, PRE-AUTH ones included —
 *    and had no tripwire, no boot warning and no dashboard row, while the
 *    directly comparable `MEDIA_DEV_ROUTE_ENABLED` gets a loud `[security]`
 *    line from the same function. Worse, `toFailureRecord` shares the builder,
 *    so debug blocks are PERSISTED into job rows and survive turning it off.
 *
 * THE RULE. A DedaloError is the engine speaking DELIBERATELY — through its
 * WIRE sentence, `wireMessage()` (registry English, or the vetted
 * `publicMessage` under a public code). Its `.message` is the LOG-ONLY field
 * (dedalo_error.ts): a provider constructor names the api_key_env it could not
 * read there, a path validator the rejected segment. Three doors read that
 * field off a caught DedaloError and forwarded it — the SEC-18 leak in its
 * second spelling (vision.ts's production model resolver, whose
 * `{ok:false, message}` IS `declined.detail`; `declineDetail`; `rejectedUpload`)
 * — and `error_taxonomy_tripwire` A6 could not see the first because it
 * blanked every `message:` key. Anything else is an exception that merely
 * happened — it travels as `cause`, to the log, never to the caller. Outcome
 * legs: identify_vision (production resolver, hermetic), identify_proposals_api
 * (declineDetail, hermetic), media_upload_endpoint (rejectedUpload, db).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** The one raw-exception spelling family, shared with error_taxonomy_tripwire A5/A6. */
const RAW_EXCEPTION_TEXT =
	/\b(?:error|err)\.message\b|String\(\s*(?:error|err)\s*\)|\((?:error|err) as Error\)\.message|\$\{\s*(?:error|err)\s*\}/;
/**
 * A DedaloError's `.message` is its LOG field (dedalo_error.ts: "never the
 * wire" — a provider constructor names its api_key_env there); the sentence a
 * door may forward is `wireMessage(error)`. Reading `.message` off a caught
 * DedaloError to put it anywhere but a log line is the SEC-18 leak in its
 * second spelling (vision.ts's model resolver, `declineDetail`, `rejectedUpload`).
 */
const DEDALO_ERROR_LOG_FIELD =
	/instanceof DedaloError\s*(?:\)\s*)?(?:\?|return)\s*(?:error|err)\.message/;

/**
 * Two views of a source, same length as it: `code` with every comment blanked,
 * `structure` with every string / template TEXT blanked as well (the code
 * inside a template's `${…}` stays). Brackets and commas found in `structure`
 * are therefore the program's own — never a `;` or a `)` inside a log sentence.
 */
function sourceViews(source: string): { code: string; structure: string } {
	const code = source.split('');
	const structure = source.split('');
	const blank = (index: number, both: boolean): void => {
		if (source[index] === '\n') return;
		structure[index] = ' ';
		if (both) code[index] = ' ';
	};
	// One frame per open template: the `{` depth of the `${…}` being read, or -1
	// while reading the template's own text.
	const templates: number[] = [];
	let i = 0;
	while (i < source.length) {
		const char = source[i];
		const inText = templates.length > 0 && templates[templates.length - 1] === -1;
		if (inText) {
			if (char === '\\') {
				blank(i, false);
				blank(i + 1, false);
				i += 2;
			} else if (char === '`') {
				templates.pop();
				i++;
			} else if (char === '$' && source[i + 1] === '{') {
				templates[templates.length - 1] = 0;
				i += 2;
			} else {
				blank(i, false);
				i++;
			}
			continue;
		}
		if (char === '/' && source[i + 1] === '/') {
			while (i < source.length && source[i] !== '\n') blank(i++, true);
		} else if (char === '/' && source[i + 1] === '*') {
			const end = source.indexOf('*/', i + 2);
			const stop = end === -1 ? source.length : end + 2;
			while (i < stop) blank(i++, true);
		} else if (char === "'" || char === '"') {
			i++;
			while (i < source.length && source[i] !== char && source[i] !== '\n') {
				if (source[i] === '\\') blank(i++, false);
				blank(i++, false);
			}
			i++;
		} else if (char === '`') {
			templates.push(-1);
			i++;
		} else {
			if (templates.length > 0) {
				const top = templates.length - 1;
				if (char === '{') templates[top] = (templates[top] ?? 0) + 1;
				else if (char === '}') {
					if (templates[top] === 0) templates[top] = -1;
					else templates[top] = (templates[top] ?? 0) - 1;
				}
			}
			i++;
		}
	}
	return { code: code.join(''), structure: structure.join('') };
}

/**
 * The arguments of EVERY call of `callee` in a source — `callee(…)` and
 * `x.callee(…)` alike — each argument as written (comments blanked, trimmed).
 * Bracket-matched on the structure view, so a call is found whatever follows
 * it and whatever its arguments hold (a `;` in a sentence, a nested call).
 */
function callArguments(source: string, callee: string): string[][] {
	const { code, structure } = sourceViews(source);
	const calls: string[][] = [];
	for (const match of structure.matchAll(new RegExp(`\\b${callee}\\(`, 'g'))) {
		const open = (match.index ?? 0) + match[0].length;
		const parts: string[] = [];
		let depth = 1;
		let start = open;
		let at = open;
		for (; at < structure.length && depth > 0; at++) {
			const char = structure[at];
			if (char === '(' || char === '[' || char === '{') depth++;
			else if (char === ')' || char === ']' || char === '}') depth--;
			else if (char === ',' && depth === 1) {
				parts.push(code.slice(start, at).trim());
				start = at + 1;
			}
		}
		if (depth !== 0) throw new Error(`unbalanced ${callee}( call at offset ${open}`);
		const last = code.slice(start, at - 1).trim();
		if (last !== '') parts.push(last); // a trailing comma leaves nothing
		calls.push(parts);
	}
	return calls;
}

/**
 * THE OUTCOME the bulk-revert skip calls are held to (SEC-16): a wire `code`
 * is handed over ONLY beside the literal `'failed'` reason. Measured on what a
 * call PASSES, not on how a denial is spelled: a reason that is not that
 * literal — `'out_of_scope'`, or an expression such as `outcome.kind` /
 * `error.reason` that can evaluate to it — with a code argument is the
 * violation, whatever the expression is. Returns the offending calls.
 */
function codeBesideNonFailedReason(calls: readonly string[][]): string[] {
	return calls
		.filter((parts) => parts.length >= 6 && parts[5] !== 'undefined' && parts[1] !== "'failed'")
		.map((parts) => `skip(${parts.join(', ')})`);
}

describe('no raw exception text reaches the caller', () => {
	test('bulk_revert: a denied row is COUNTED, never LOCATED; no refusal text rides skipped[] (SEC-16)', () => {
		const source = read('tools/tool_time_machine/server/bulk_revert.ts');
		const body = source.slice(source.indexOf('export async function toolTimeMachineBulkRevert'));
		expect(body.length).toBeGreaterThan(2000);
		// The defect, verbatim: coordinates interpolated on the denial entry.
		expect(
			body,
			'permissions_denied: <coordinates> on the wire enumerates records outside the caller’s scope',
		).not.toMatch(/permissions_denied/);
		// No raw exception text is pushed into ANY list in this door.
		for (const line of body.split('\n')) {
			if (!/\.push\(/.test(line)) continue;
			expect(RAW_EXCEPTION_TEXT.test(line), `raw text pushed: ${line.trim()}`).toBe(false);
		}
		// The channel is typed: a closed reason vocabulary, with the denial code in it…
		expect(source).toMatch(/export type BulkRevertSkipReason\s*=/);
		expect(source).toMatch(/'out_of_scope'/);
		expect(source).toMatch(/'failed'/);
		// …the entry carries `reason:`, and the coordinates are gated on the scope flag.
		expect(body).toMatch(/inScope\s*\?\s*\{\s*reason,\s*section_tipo:/);
		// The UNLOCATED entry is built by ONE function, and it is the whole of what
		// such an entry may be (owner ruling 2026-11-18, WC-2026-11-17 addendum):
		// the reason, plus — for `failed` ONLY — the bare wire code. No coordinate
		// key, no words; `out_of_scope` (and every other reason) is the reason
		// alone, so a principal who may not see a record never learns why.
		expect(body).toMatch(/:\s*unlocatedEntry\(reason, code\),/);
		expect(source).toMatch(
			/function unlocatedEntry\(reason: BulkRevertSkipReason, code\?: string\): BulkRevertSkipped \{\s*return reason === 'failed' && code !== undefined \? \{ reason, code \} : \{ reason \};\s*\}/,
		);
		expect(source.match(/unlocatedEntry\(/g) ?? []).toHaveLength(2); // the definition + the one call
		// The located entry names ONLY the coordinate keys — the four, plus `lang`
		// (the language region of a lang-sliced key, since the undo-log revert
		// works per region: WC-2026-09-27-bulk-revert-undo-log) — and no `detail`
		// (the words the skip() closure receives are the log's — forwarding them
		// onto the entry would re-route the raw text through the parameter the
		// fix introduced).
		// The located entry, brace-matched (it holds one nested literal, below).
		const entryOpen = /inScope\s*\?\s*\{/.exec(body);
		expect(entryOpen).not.toBeNull();
		const entryStart = (entryOpen?.index ?? 0) + (entryOpen?.[0].length ?? 0);
		let depth = 1;
		let entryEnd = entryStart;
		while (depth > 0 && entryEnd < body.length) {
			const char = body[entryEnd];
			if (char === '{') depth++;
			else if (char === '}') depth--;
			entryEnd++;
		}
		const entryText = body.slice(entryStart, entryEnd - 1);
		// ONE optional key besides the coordinates: the failed unit's registry `code`
		// (2026-10-12, owner decision A; WC-2026-10-11-parent-link-cycle-every-door,
		// 238feca0e4). A closed wire code (`tree.cycle`), never words — pinned below
		// to the ONE converter. Since 2026-11-18 it rides an UNLOCATED `failed`
		// entry too (unlocatedEntry, above) — a denied row still carries nothing
		// but `{ reason }`.
		const CODE_SPREAD = /\.\.\.\(code === undefined \? \{\} : \{ code \}\),?/;
		expect(entryText.match(new RegExp(CODE_SPREAD.source, 'g')) ?? []).toHaveLength(1);
		const coordinates = entryText.replace(CODE_SPREAD, '');
		const entryKeys = [...coordinates.matchAll(/(?:^|,)\s*([a-z_]+)\s*(?=:|,|$)/g)].map(
			(m) => m[1],
		);
		expect(entryKeys.sort()).toEqual(['lang', 'reason', 'section_id', 'section_tipo', 'tipo']);
		expect(coordinates).not.toMatch(/detail|\.\.\.|[{}]/);
		// Where `code` comes from: every skip() call that passes a sixth argument
		// passes the converter's code — `failureCodeOf(error)` or a record outcome's
		// `outcome.code` — and both are `toDedaloError(error).code`, nothing else.
		const skipCalls = callArguments(source, 'skip');
		// Floored: a scan that found no call would make every loop below green.
		expect(skipCalls.length).toBeGreaterThanOrEqual(12);
		for (const parts of skipCalls) expect(parts.length).toBeGreaterThanOrEqual(4);
		const codeArguments = skipCalls.filter((parts) => parts.length >= 6).map((parts) => parts[5]);
		expect(codeArguments.length).toBeGreaterThanOrEqual(4);
		for (const argument of codeArguments) {
			expect(['failureCodeOf(error)', 'outcome.code', 'failure.code']).toContain(argument ?? '');
		}
		// A code is only ever handed over beside the LITERAL 'failed' reason — never
		// beside a denial, and never beside a reason the call does not spell out
		// (`outcome.kind`, `error.reason`: an expression that can BE the denial).
		expect(codeBesideNonFailedReason(skipCalls)).toEqual([]);
		// …and at least one call really is of each kind the rule separates.
		expect(skipCalls.filter((parts) => parts[1] === "'out_of_scope'").length).toBe(1);
		expect(
			skipCalls.filter((parts) => !/^'[a-z_]+'$/.test(parts[1] ?? '')).length,
		).toBeGreaterThanOrEqual(3);
		// POSITIVE CONTROLS — the measure reds on each shape of the violation, also
		// the ones a spelling match misses: a non-literal reason, a call that is
		// not a statement, a sentence holding `;` and `)`, a nested template.
		const violations = [
			"report.skip(row, outcome.kind, false, null, 'error', outcome.code);",
			"if (x) skip(locateKey(error.key), error.reason, located, error.message, 'warn', failureCodeOf(error));",
			"const done = skip(row, 'out_of_scope', false, 'a; b) c', 'error', failure.code) ?? null;",
			"skip(\n\trow, // 'failed',\n\tdenied ? 'out_of_scope' : 'failed',\n\tfalse,\n\t`x ${f(`y ${z}`, 1)}; )`,\n\t'error',\n\tfailureCodeOf(error),\n);",
		];
		for (const violation of violations) {
			expect(codeBesideNonFailedReason(callArguments(violation, 'skip')), violation).toHaveLength(
				1,
			);
		}
		const lawful = [
			'report.skip(row, outcome.kind, false, null);',
			"skip(row, 'failed', inScope, 'a, b; c)', 'error', failureCodeOf(error));",
			"skip(row, error.reason, located, `${a}, ${b}`, 'warn', undefined);",
			"// skip(row, outcome.kind, false, null, 'error', outcome.code);",
		];
		for (const call of lawful) {
			expect(codeBesideNonFailedReason(callArguments(call, 'skip')), call).toEqual([]);
		}
		expect(source).toMatch(
			/function failureCodeOf\(error: unknown\): string \{\s*return toDedaloError\(error\)\.code;\s*\}/,
		);
		const records = read('tools/tool_time_machine/server/bulk_revert_records.ts');
		const codeValues = [...records.matchAll(/\bcode:\s*([^,}\n]+)/g)].map((m) => m[1]?.trim());
		expect(codeValues.length).toBeGreaterThanOrEqual(1);
		for (const value of codeValues) {
			if (value === 'string') continue; // the outcome TYPE's `code: string` field
			expect(value).toBe('toDedaloError(error).code');
		}
		// `failure.code` — a key the PLAN could not place (bulk_revert_plan.ts): the
		// same converter, kept beside the log text; `model.code` only relays it.
		const plan = read('tools/tool_time_machine/server/bulk_revert_plan.ts');
		const planCodes = [...plan.matchAll(/\bcode:\s*([^,}\n]+)/g)].map((m) =>
			(m[1] ?? '').trim().replace(/;$/, ''),
		);
		expect(planCodes.filter((value) => value === 'toDedaloError(error).code')).toHaveLength(2);
		for (const value of planCodes) {
			expect(['string', 'toDedaloError(error).code', 'model.code']).toContain(value);
		}
		// The gate sets the flag AFTER both halves pass, and the denial passes `false`.
		expect(body).toMatch(/skip\(row, 'out_of_scope', false, null\)/);
		expect(body).toMatch(/inScope = true;/);
		// The words go to the log, with the request id.
		expect(body).toMatch(/console\.(warn|error)\(line\)/);
		expect(body).toMatch(/request \$\{requestId\}/);
		// …and EVERY catch hands the exception text to the log path, never to an
		// entry: each one reports through skip(…, 'failed', <scope flag>, …) and
		// pushes nothing itself. (Several since the undo-log rewrite: the
		// cascade undelete and the units.) The unit loop's catch is the one that
		// may locate — gated on the SAME inScope flag. The born-record deletes
		// catch PER RECORD in bulk_revert_records.ts (failedOnThrow): the text
		// becomes that record's `failed` outcome's detail, which reportRecord
		// hands to skip() — the log parameter — never onto an entry (below).
		const catchBlocks = body
			.split('} catch (error) {')
			.slice(1)
			.map((block) => block.slice(0, 700));
		expect(catchBlocks.length).toBeGreaterThanOrEqual(2);
		const failedBranch = /outcome\.kind === 'failed'\)([^;]*);/.exec(body);
		// Located ONLY on the flag the per-record catch sets after the scope gate.
		expect(failedBranch?.[1]).toMatch(
			/skip\(\s*row,\s*'failed',\s*outcome\.located,\s*outcome\.detail,/,
		);
		// A catch may hand the exception to ONE same-file helper (the cascade
		// group's reportGroupFailure, extracted for the complexity cap): the
		// helper's body is then held to the same law as an inline catch.
		const helperBody = (block: string): string => {
			const call = /^\s*([a-zA-Z_]\w*)\([^;]*\berror\b[^;]*\);/.exec(block);
			if (call === null || /\bskip\(/.test(block)) return block;
			const at = source.indexOf(`function ${call[1]}(`);
			expect(at, `catch delegates to ${call[1]}, not found in the file`).toBeGreaterThan(0);
			return source.slice(at, at + 1200);
		};
		for (const block of catchBlocks) {
			const handled = helperBody(block);
			expect(handled).toMatch(/skip\(\s*[^;]*?,\s*'failed',\s*(?:inScope|false),/);
			expect(handled).not.toMatch(/push\(/);
			expect(block).not.toMatch(/push\(/);
		}
		expect(catchBlocks.some((block) => /'failed',\s*inScope,/.test(block))).toBe(true);
	});

	test('vision: a model that fails declines with a DELIBERATE sentence, the exception stays in the log (SEC-18)', () => {
		const source = read('src/ai/identify/vision.ts');
		const at = source.indexOf("reason: 'model_error'");
		expect(at).toBeGreaterThan(0);
		const block = source.slice(at, at + 400);
		expect(
			block,
			'declined.detail reaches an ok:true payload verbatim (dd_identify_api) at read level 1',
		).not.toMatch(RAW_EXCEPTION_TEXT);
		expect(block).toMatch(/the server log records why/);
		// the log line still carries the original
		expect(source.slice(Math.max(0, at - 800), at)).toMatch(
			/console\.warn\(`\[identify\/vision\] model '\$\{model\.id\}' failed: \$\{String\(error\)\}`\)/,
		);
		// THE PRODUCTION RESOLVER (dd_identify_api never injects resolveModel):
		// its `{ok:false, message}` result IS `declined.detail`, so a catalog
		// throw speaks through `wireMessage` and any other throw through a
		// deliberate sentence — `.message` of a DedaloError is the log field
		// naming the api_key_env `publicModelList` exists to hide.
		const resolver = source.slice(source.indexOf('const defaultModelResolver'));
		expect(resolver.length).toBeGreaterThan(300);
		const resolverBody = resolver.slice(0, resolver.indexOf('\n};') + 3);
		expect(resolverBody).toMatch(/catch \(error\)/);
		expect(resolverBody).not.toMatch(DEDALO_ERROR_LOG_FIELD);
		for (const line of resolverBody.split('\n')) {
			if (/console\./.test(line)) continue;
			expect(RAW_EXCEPTION_TEXT.test(line), `raw text in the resolver: ${line.trim()}`).toBe(false);
		}
		expect(resolverBody).toMatch(
			/instanceof ModelCatalogError\) return \{ ok: false, message: wireMessage\(error\) \}/,
		);
		expect(resolverBody).toMatch(
			/instanceof DedaloError \? wireMessage\(error\) : NO_USABLE_MODEL_DETAIL/,
		);
		expect(resolverBody).toMatch(
			/console\.warn\(`\[identify\/vision\] no usable vision model: \$\{String\(error\)\}`\)/,
		);
		expect(source).toMatch(
			/NO_USABLE_MODEL_DETAIL = 'no usable vision model; the server log records why'/,
		);
	});

	test('the upload refusal puts only a DELIBERATE sentence on the wire', () => {
		const source = read('src/core/media/ingest/upload_endpoint.ts');
		const fn = source.slice(source.indexOf('function rejectedUpload'));
		expect(fn.length).toBeGreaterThan(200);
		// The defect, verbatim: publicMessage taking whatever threw.
		expect(
			fn.slice(0, 1600),
			'publicMessage is a WIRE field — assigning error.message to it publishes ' +
				"mkdirSync/writeFileSync paths to a consultation-only account's browser",
		).not.toMatch(/publicMessage:\s*error instanceof Error \? error\.message/);
		// The rule: only a typed refusal speaks — through its WIRE sentence.
		expect(fn.slice(0, 1800)).toMatch(
			/error instanceof DedaloError \? wireMessage\(error\) : null/,
		);
		expect(
			fn.slice(0, 1800),
			'a DedaloError’s .message is the log field (it may name a path); the wire sentence is wireMessage()',
		).not.toMatch(DEDALO_ERROR_LOG_FIELD);
		// The original still travels for the log.
		expect(fn.slice(0, 1800)).toMatch(/cause: error/);
	});

	test('a failed identify source does not echo what threw', () => {
		const source = read('src/core/api/handlers/dd_identify_api.ts');
		// `detail` sits inside an ok:true payload, so no ladder applies to it.
		expect(
			source,
			'detail: error.message inside ok:true publishes Postgres/filesystem text with no ' +
				'disclosure control at all',
		).not.toMatch(/detail:\s*error instanceof Error \? error\.message/);
		expect(source).toContain('function declineDetail');
		const helper = source.slice(source.indexOf('function declineDetail'));
		const helperBody = helper.slice(0, helper.indexOf('\n}') + 2);
		expect(helperBody).toMatch(/if \(error instanceof DedaloError\) return wireMessage\(error\);/);
		expect(
			helperBody,
			'declineDetail forwarded ANY DedaloError’s log-only .message into an ok:true payload',
		).not.toMatch(DEDALO_ERROR_LOG_FIELD);
		for (const line of helperBody.split('\n')) {
			if (/console\./.test(line)) continue;
			expect(RAW_EXCEPTION_TEXT.test(line), `raw text in declineDetail: ${line.trim()}`).toBe(
				false,
			);
		}
	});

	test('the switch that collapses the ladder announces itself at boot', () => {
		const server = read('src/server.ts');
		expect(
			server,
			'DEDALO_DEBUG_API_ERRORS attaches exception+stack+cause_chain to EVERY failure body, ' +
				'pre-auth included, and job rows PERSIST it — it must be as loud as ' +
				'MEDIA_DEV_ROUTE_ENABLED, which has had a [security] line for a year',
		).toMatch(/DEDALO_DEBUG_API_ERRORS/);
		const block = server.slice(server.indexOf("readEnv('DEDALO_DEBUG_API_ERRORS')"));
		expect(block.slice(0, 900)).toContain('[security]');
		// It must warn when ON, not merely mention the key.
		expect(block.slice(0, 300)).toMatch(/===\s*'true'/);
	});

	test('the comparator it is measured against is still loud', () => {
		// Anti-vacuity of the precedent: if MEDIA_DEV_ROUTE_ENABLED ever stops
		// warning, the argument "as loud as its neighbour" is empty and this rule
		// should be re-argued rather than left resting on a habit nobody keeps.
		const server = read('src/server.ts');
		expect(server).toMatch(/\[security\] MEDIA_DEV_ROUTE_ENABLED=true/);
	});

	test('anti-vacuity: every slice found its target, and the raw-text matcher fires', () => {
		expect(read('tools/tool_time_machine/server/bulk_revert.ts')).toContain(
			'export async function toolTimeMachineBulkRevert',
		);
		expect(read('src/ai/identify/vision.ts')).toContain("reason: 'model_error'");
		expect(RAW_EXCEPTION_TEXT.test('errors.push(`${x}: ${(error as Error).message}`)')).toBe(true);
		expect(RAW_EXCEPTION_TEXT.test('detail: `did not answer: ${String(error)}`')).toBe(true);
		expect(RAW_EXCEPTION_TEXT.test('detail: `the server log records why: ${error}`')).toBe(true);
		expect(RAW_EXCEPTION_TEXT.test('skipped.push({ reason })')).toBe(false);
		expect(DEDALO_ERROR_LOG_FIELD.test('error instanceof DedaloError ? error.message : null')).toBe(
			true,
		);
		expect(
			DEDALO_ERROR_LOG_FIELD.test('if (error instanceof DedaloError) return error.message;'),
		).toBe(true);
		expect(
			DEDALO_ERROR_LOG_FIELD.test('error instanceof DedaloError ? wireMessage(error) : null'),
		).toBe(false);
		expect(read('src/core/media/ingest/upload_endpoint.ts')).toContain('function rejectedUpload');
		expect(read('src/core/api/handlers/dd_identify_api.ts')).toContain('declineDetail');
		expect(read('src/server.ts')).toContain("readEnv('DEDALO_DEBUG_API_ERRORS')");
	});
});
