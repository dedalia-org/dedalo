/**
 * resolveSqlForDisplay + the convert_search_object_to_sql_query authz door
 * (dd_utils_api — the sqo_test_environment maintenance widget).
 *
 * THE CONTRACT under test (pure; no DB, no scratch writes):
 * - the placeholder substitution runs HIGH→LOW. An ascending loop would rewrite
 *   $1 inside $10/$11 first and corrupt every query with ten or more params.
 *   The descending order is asserted directly AND against the ascending result
 *   as a negative control, so a reverted loop cannot stay green.
 * - literalisation is type-driven: numbers go bare, everything else is
 *   single-quoted with '' doubling (display-only — the EXECUTED query always
 *   uses the bound params, never this string).
 * - the handler is global-admin only: a non-admin principal gets 403 with the
 *   named refusal, BEFORE any assembler/DB work.
 * - a source assertion proves the inline loop was deleted from the call site,
 *   so a future revert cannot silently un-wire the extraction.
 *
 * DELIBERATELY NOT COVERED: the "assembler failure rides as result:false"
 * branch. `sanitizeClientSqo({})` does not throw, and `msg startsWith 'Error: '`
 * is satisfied by ANY throw — including a missing test DB — so the case is
 * green on a machine that never reached the assembler. It needs a named
 * refusal plus a positive control to be honest; both require a live DB.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionHandler, ApiRequestContext } from '../../src/core/api/handler_context.ts';
import { resolveSqlForDisplay, utilsApiActions } from '../../src/core/api/handlers/dd_utils_api.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { Principal } from '../../src/core/security/permissions.ts';

const HANDLER_PATH = join(import.meta.dir, '../../src/core/api/handlers/dd_utils_api.ts');

/** The bug the descending loop exists to prevent, written out. */
function resolveAscending(sql: string, params: readonly unknown[]): string {
	let resolved = sql;
	for (let i = 1; i <= params.length; i++) {
		const param = params[i - 1];
		const literal =
			typeof param === 'number' ? String(param) : `'${String(param).replace(/'/g, "''")}'`;
		resolved = resolved.replaceAll(`$${i}`, literal);
	}
	return resolved;
}

describe('resolveSqlForDisplay — placeholder ordering', () => {
	const ELEVEN = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];

	test('substitutes high→low so $1 never matches inside $10/$11', () => {
		expect(resolveSqlForDisplay('WHERE a=$1 AND b=$10 AND c=$11', ELEVEN)).toBe(
			"WHERE a='A' AND b='J' AND c='K'",
		);
	});

	test('negative control: an ascending loop produces a DIFFERENT, corrupt string', () => {
		const ascending = resolveAscending('WHERE a=$1 AND b=$10 AND c=$11', ELEVEN);
		// $1 eaten first: $10 becomes 'A'0, $11 becomes 'A'1.
		expect(ascending).toBe("WHERE a='A' AND b='A'0 AND c='A'1");
		expect(resolveSqlForDisplay('WHERE a=$1 AND b=$10 AND c=$11', ELEVEN)).not.toBe(ascending);
	});

	test('replaces EVERY occurrence of a repeated placeholder', () => {
		expect(resolveSqlForDisplay('a=$1 OR b=$1 OR c=$2', ['x', 'y'])).toBe(
			"a='x' OR b='x' OR c='y'",
		);
	});

	test('placeholders beyond the params array are left untouched', () => {
		// One param, two placeholders: $2 has no value and survives verbatim.
		expect(resolveSqlForDisplay('a=$1 AND b=$2', ['x'])).toBe("a='x' AND b=$2");
	});

	test('no params → the template is returned unchanged', () => {
		expect(resolveSqlForDisplay('SELECT 1', [])).toBe('SELECT 1');
	});
});

describe('resolveSqlForDisplay — literalisation', () => {
	test('numbers bare, strings quoted, embedded quotes doubled', () => {
		expect(resolveSqlForDisplay('a=$1 AND b=$2 AND c=$3', [42, "O'Brien", 'plain'])).toBe(
			"a=42 AND b='O''Brien' AND c='plain'",
		);
	});

	test('a NUMERIC STRING is quoted (the branch keys on typeof, not on looking numeric)', () => {
		expect(resolveSqlForDisplay('a=$1', ['42'])).toBe("a='42'");
	});

	test('several quotes in one value are each doubled', () => {
		expect(resolveSqlForDisplay('a=$1', ["it's 'quoted'"])).toBe("a='it''s ''quoted'''");
	});

	test('non-number non-string params are String()-coerced then quoted', () => {
		// Faithful move of the original: null/undefined/true have no special
		// branch, so they stringify into the quoted form.
		expect(resolveSqlForDisplay('a=$1 AND b=$2 AND c=$3', [null, true, undefined])).toBe(
			"a='null' AND b='true' AND c='undefined'",
		);
	});
});

/** A context with a seeded principal, as dispatchRqo builds after the auth gate. */
function contextFor(principal: Principal): ApiRequestContext {
	return {
		requestId: 'test-sqo-console',
		clientIp: '127.0.0.1',
		session: null,
		csrfCandidate: null,
		principal,
	};
}

const RQO = {
	dd_api: 'dd_utils_api',
	action: 'convert_search_object_to_sql_query',
	options: {},
} as unknown as Rqo;

describe('convert_search_object_to_sql_query — authorization door', () => {
	const registered = utilsApiActions.convert_search_object_to_sql_query;
	/** Loud, not `?.` — an unregistered action must FAIL every case below. */
	const handler = (rqo: Rqo, context: ApiRequestContext): ReturnType<ActionHandler> => {
		if (registered === undefined) {
			throw new Error('utilsApiActions.convert_search_object_to_sql_query is not registered');
		}
		return registered(rqo, context);
	};

	test('the action is registered', () => {
		expect(typeof registered).toBe('function');
	});

	test('a non-global-admin is refused: a thrown perm.denied (403), named — before any query work', async () => {
		// Envelope v2: the handler THROWS; the dispatch chokepoint converts it to
		// the 403 envelope. Thrown means no SQL / db_data can escape to the client.
		const thrown = await handler(
			RQO,
			contextFor({ userId: 42, isGlobalAdmin: false, isDeveloper: false }),
		).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(DedaloError);
		expect((thrown as DedaloError).code).toBe('perm.denied');
		expect((thrown as DedaloError).spec.status).toBe(403);
		expect((thrown as DedaloError).publicMessage).toBe(
			'Only global admins can use the SQO test environment',
		);
	});

	test('a developer flag does NOT open the door — only isGlobalAdmin does', async () => {
		const thrown = await handler(
			RQO,
			contextFor({ userId: 43, isGlobalAdmin: false, isDeveloper: true }),
		).catch((error: unknown) => error);
		expect((thrown as DedaloError).code).toBe('perm.denied');
	});

	test('an unauthenticated context throws (requirePrincipal), never falls through', async () => {
		const anonymous: ApiRequestContext = {
			requestId: 'test-sqo-console-anon',
			clientIp: '127.0.0.1',
			session: null,
			csrfCandidate: null,
		};
		await expect(handler(RQO, anonymous)).rejects.toThrow(/requirePrincipal/);
	});
});

describe('convert_search_object_to_sql_query — a TYPED refusal keeps its code', () => {
	// The catch wraps only UNTYPED throws into search.failed (500). A typed one —
	// the referenced_by bound's 503 db.statement_timeout (DB leg: the console door
	// in referenced_by_filter_native's every-door test), a request.invalid_options,
	// this search.invalid_sqo — passes through with its own code and status.
	const handler = utilsApiActions.convert_search_object_to_sql_query as ActionHandler;
	const admin = contextFor({ userId: -1, isGlobalAdmin: true, isDeveloper: true });
	const rqoWith = (options: Record<string, unknown>) => ({ ...RQO, options }) as unknown as Rqo;

	test('a typed sanitizer refusal (search.invalid_sqo, 400-class) is NOT re-wrapped into search.failed', async () => {
		let filter: unknown = [];
		for (let level = 0; level < 100; level++) filter = [filter];
		const thrown = await handler(rqoWith({ section_tipo: 'test3', filter }), admin).catch(
			(error: unknown) => error,
		);
		expect(thrown).toBeInstanceOf(DedaloError);
		expect((thrown as DedaloError).code).toBe('search.invalid_sqo');
	});

	test('control: an UNTYPED throw is still wrapped as search.failed (the cause kept)', async () => {
		const options = { section_tipo: 'test3' } as Record<string, unknown>;
		Object.defineProperty(options, 'zz_untyped', {
			enumerable: true,
			get() {
				throw new Error('zz untyped sanitizer failure');
			},
		});
		const thrown = await handler(rqoWith(options), admin).catch((error: unknown) => error);
		expect(thrown).toBeInstanceOf(DedaloError);
		expect((thrown as DedaloError).code).toBe('search.failed');
		expect(String(((thrown as DedaloError).cause as Error | undefined)?.message)).toContain(
			'zz untyped',
		);
	});
});

describe('the call site is REWIRED (extraction-without-rewire guard)', () => {
	const source = readFileSync(HANDLER_PATH, 'utf8');

	test('the handler calls the extracted function', () => {
		// The text comes through the inspection door (search_statement.ts
		// searchStatementText); the statement itself runs through runSearch.
		expect(source).toContain('resolveSqlForDisplay(shown.sql, shown.params)');
	});

	test('the inline substitution loop is GONE from the handler body', () => {
		expect(source).not.toContain('let resolved = built.sql;');
		expect(source).not.toContain('for (let i = built.params.length; i >= 1; i--)');
		expect(source).not.toContain('const param = built.params[i - 1];');
	});

	test('exactly one substitution loop remains in the file (the extracted one)', () => {
		const loops = source.match(/for \(let i = params\.length; i >= 1; i--\)/g) ?? [];
		expect(loops.length).toBe(1);
	});
});
