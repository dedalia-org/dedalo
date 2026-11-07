/**
 * TOOL REFUSAL REASON KEYS — the closed map behind `details.reason_key`
 * (engineering/ERRORS_SPEC.md §9.1; WC-2026-11-06-tool-reason-key).
 *
 * A tool refuses with an existing PUBLIC code plus `details.reason_key`, one key
 * of the closed map its server module declares (`ToolServerModule.reasonKeys`:
 * key → the English fallback sentence); the browser resolves the sentence from
 * the tool's own `register.json` label `reason_<key>` and falls back to the
 * DECLARED sentence — the throw never carries one. Three things keep that honest,
 * and this gate holds each of them:
 *
 *  A. STATIC, per tool (every `tools/tool_*\/server/` tree, listed by the shared
 *     write-path corpus lister):
 *     (a) every `reason_key: '<literal>'` is in the tool's declared set;
 *     (b) every declared key has a `reason_<key>` label in every language the
 *         tool's labels carry (and always `lg-eng`);
 *     (c) no `reason_*` label is dead (maps to no declared key);
 *     (d) the declaration is valid — the SAME check the loader runs: an object,
 *         every key matches REASON_KEY_PATTERN, every value a vetted sentence;
 *     (e) a tool that declares keys never names one of the converter's body
 *         builders (`toErrorBody` / `toErrorEnvelope` / `toStructuredErr` /
 *         `toFailureRecord` / `toStreamFrame`) — not as a call, not in an import
 *         (aliased or not), not through a namespace or a destructure; a refusal
 *         it embeds in a payload goes through `toolErrorBody`, which runs the
 *         check the thrown path gets from the loader. The list of builders is
 *         pinned complete against `errors/convert.ts` (section D), so a builder
 *         added there is red here until it is classified;
 *     (f) (retired) the sentence used to be a literal beside the throw, which the
 *         gate could read only as one object literal. It is now declared ONCE and
 *         vetted by the loader, and the runtime guard refuses any other sentence
 *         (section B), so there is no spelling left to scan;
 *     (g) a `reason_*` label's `${param}` is a detail some opted-in code
 *         declares, and `%s` is not used (the tool label is filled by name only).
 *  B. RUNTIME, on a scratch fixture tool admitted through the loader's own
 *     per-tool door (`admitToolModule`): a declared key on an opted-in code
 *     reaches the wire with the DECLARED sentence (supplied by the guard, or
 *     accepted when the throw carries exactly it); an undeclared key, a code that
 *     does not carry the key, a different sentence (an upstream's text), a key
 *     outside the grammar, or a tool that declares none is `internal.invariant` —
 *     loud, never a silently dropped detail — whether the refusal is THROWN or a
 *     failure envelope the handler RETURNS. The guard covers handlers, `admit`
 *     hooks and routes, never double-wraps, keeps the raw function reachable
 *     (`unguarded`), echoes an offending key sanitised (no log forging), and a
 *     malformed declaration (shape, key, sentence length, control / bidi /
 *     zero-width characters) refuses the tool at load. The embedder
 *     `toolErrorBody` applies the same check to a body built for a payload and
 *     LOGS the refusal it replaces.
 *  C. WIRING, on the REAL registry: every handler, `admit` hook and route that
 *     `loadToolModules()` serves is the guard around the raw function the tool
 *     module exports — the outcome of the scan, not the spelling of the loader. A
 *     scan that registered an unguarded module under any spelling is red here.
 *     The client half (the `tool` stamp, the label registry, the resolution
 *     order) is pinned in the browser suite and in `client_error_contract_tripwire`.
 *     (That core never writes a `reason_key` key is `error_taxonomy_tripwire` A7.)
 *
 * Every static matcher is a pure function over facts, so section D plants an
 * offender of each kind and proves the matcher fires (a gate that cannot go red
 * is decoration). Hermetic: tracked-source reads and in-process fixtures only.
 *
 * HONEST LIMITS: the literal scan sees `reason_key: 'x'` spellings, not a value
 * computed at the throw (`reason_key: reasonFor(code)`) — that is the runtime
 * guard's job, which is why B is load-bearing and not a restatement of A. The
 * guard sees what is thrown out of, or returned by, a wrapped entry, plus what
 * goes through `toolErrorBody`; an error body a tool hand-assembles and nests in
 * a payload with no builder at all, and the `Response` a route returns, are
 * outside it (error_taxonomy_tripwire B1 blocks the `ok: false` literal that
 * would usually carry one). Leg (e) reads identifiers: a deliberately obfuscated
 * spelling (a name assembled from string pieces) is not seen. The label check
 * proves a label EXISTS in each language, not that it is well translated.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import * as converter from '../../src/core/errors/convert.ts';
import { toErrorEnvelope } from '../../src/core/errors/convert.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import { formatErrorLine } from '../../src/core/errors/log.ts';
import { REASON_KEY, REASON_KEY_CODES, specOf } from '../../src/core/errors/registry.ts';
import {
	admitToolModule,
	loadToolModules,
	validateToolModule,
} from '../../src/core/tools/loader.ts';
import type {
	ToolActionContext,
	ToolActionSpec,
	ToolAdmissionContext,
	ToolHttpRoute,
	ToolResponse,
	ToolServerModule,
} from '../../src/core/tools/module.ts';
import {
	PUBLIC_MESSAGE_MAX,
	reasonKeysDeclarationProblem,
	toolErrorBody,
	unguarded,
} from '../../src/core/tools/reason_keys.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import { REPO_ROOT, writePathSourceFiles } from '../helpers/write_path_corpus.ts';

const TOOLS_DIR = join(REPO_ROOT, 'tools');

// ---------------------------------------------------------------------------
// A. Static facts and the pure checkers
// ---------------------------------------------------------------------------

interface LabelEntry {
	readonly lang: string;
	readonly name: string;
	readonly value: string;
}

/** Everything the static checker judges about one tool. */
interface ToolFacts {
	readonly name: string;
	/** `tool.reasonKeys` as the module declares it (`{}` when absent): key → fallback sentence. */
	readonly declared: Readonly<Record<string, string>>;
	/** path → comment-stripped source (string contents kept) of `tools/<tool>/server/**`. */
	readonly sources: Readonly<Record<string, string>>;
	readonly labels: readonly LabelEntry[];
}

/** A key written with a string literal: `reason_key: 'x'` / `"x"` / `` `x` `` (the value is group 2). */
const REASON_KEY_LITERAL = /(?<![\w$.])reason_key\s*:\s*(['"`])([^'"`\n]*)\1/g;

const REASON_LABEL_PREFIX = 'reason_';

/** The declared keys of a tool. */
const declaredKeys = (facts: ToolFacts): string[] => Object.keys(facts.declared);

/** Every `reason_key: '<literal>'` value in a (comment-stripped) source. */
function reasonKeyLiterals(code: string): string[] {
	return [...code.matchAll(REASON_KEY_LITERAL)].map((match) => match[2] as string);
}

/**
 * (d) the declaration is valid: the loader's OWN check (`reasonKeysDeclarationProblem`),
 * not a second copy of the grammar — so the gate and the door cannot disagree.
 */
function declarationViolations(facts: ToolFacts): string[] {
	const problem = reasonKeysDeclarationProblem({ reasonKeys: facts.declared } as ToolServerModule);
	return problem === null ? [] : [`${facts.name}: ${problem}`];
}

/** (a) every literal reason_key under the tool's server tree is declared. */
function literalViolations(facts: ToolFacts): string[] {
	const declared = new Set(declaredKeys(facts));
	const out: string[] = [];
	for (const [path, code] of Object.entries(facts.sources)) {
		for (const literal of reasonKeyLiterals(code)) {
			if (!declared.has(literal)) {
				out.push(`${path}: reason_key '${literal}' is not in ${facts.name}'s declared reasonKeys`);
			}
		}
	}
	return out;
}

/** (b) a `reason_<key>` label for every declared key, in every language the tool is translated into. */
function missingLabelViolations(facts: ToolFacts): string[] {
	if (declaredKeys(facts).length === 0) return [];
	const langs = new Set(['lg-eng', ...facts.labels.map((label) => label.lang)]);
	const out: string[] = [];
	for (const key of declaredKeys(facts)) {
		for (const lang of langs) {
			const label = facts.labels.find(
				(entry) => entry.lang === lang && entry.name === `${REASON_LABEL_PREFIX}${key}`,
			);
			if (label === undefined || label.value.trim() === '') {
				out.push(`${facts.name}: no ${REASON_LABEL_PREFIX}${key} label in ${lang}`);
			}
		}
	}
	return out;
}

/** (c) a `reason_*` label whose key the tool does not declare is dead. */
function deadLabelViolations(facts: ToolFacts): string[] {
	const declared = new Set(declaredKeys(facts));
	return facts.labels
		.filter((label) => label.name.startsWith(REASON_LABEL_PREFIX))
		.filter((label) => !declared.has(label.name.slice(REASON_LABEL_PREFIX.length)))
		.map(
			(label) => `${facts.name}: dead label ${label.name} (${label.lang}) — no declared reason key`,
		);
}

/**
 * Every function `errors/convert.ts` exports that builds a wire error body (or a
 * surface carrying one): HTTP body, envelope, MCP structured error, persisted
 * failure record, stream frame. A tool that declares reasonKeys builds an
 * embedded refusal with `toolErrorBody` instead (the check lives there). The list
 * is pinned COMPLETE against the module itself (section D).
 */
const BODY_BUILDERS = [
	'toErrorBody',
	'toErrorEnvelope',
	'toStructuredErr',
	'toFailureRecord',
	'toStreamFrame',
] as const;

/** The convert.ts exports that are NOT body builders (named, so a new export has to be classified). */
const NOT_BODY_BUILDERS = ['toDedaloError', 'wireMessage', 'ok'] as const;

/**
 * A builder named as an identifier — a call, an import specifier (aliased or
 * not), a namespace member (`errors.toStreamFrame(`), a destructure. Run on the
 * string-BLANKED view, so a sentence that merely mentions the name is not one.
 */
const BUILDER_IDENTIFIER = new RegExp(`(?<![\\w$])(${BODY_BUILDERS.join('|')})(?![\\w$])`, 'g');

/** …and the computed spelling `errors['toErrorBody']`, which lives in a string (the KEPT view). */
const BUILDER_COMPUTED = new RegExp(`\\[\\s*['"\`](${BODY_BUILDERS.join('|')})['"\`]\\s*\\]`, 'g');

/** (e) a tool that declares keys does not build a wire body without the check. */
function embedderViolations(facts: ToolFacts): string[] {
	if (declaredKeys(facts).length === 0) return [];
	const out: string[] = [];
	for (const [path, code] of Object.entries(facts.sources)) {
		const named = [
			...stripComments(code, { blankStrings: true }).matchAll(BUILDER_IDENTIFIER),
			...stripComments(code).matchAll(BUILDER_COMPUTED),
		];
		for (const match of named) {
			out.push(
				`${path}: ${facts.name} declares reasonKeys but names ${match[1]} — use toolErrorBody(tool, action, error) so a reason_key cannot ride a payload past the declaration`,
			);
		}
	}
	return out;
}

/**
 * The `${param}` names a reason label may use: the details the opted-in codes
 * declare, minus the key itself. Derived from the registry, so adding a code to
 * the opt-in set widens it deliberately.
 */
function allowedLabelPlaceholders(): ReadonlySet<string> {
	const names = REASON_KEY_CODES.flatMap((code) => specOf(code).details_keys ?? []);
	return new Set(names.filter((name) => name !== REASON_KEY));
}

/** (g) a reason label's placeholders can be filled from the wire, and no `%s`. */
function placeholderViolations(facts: ToolFacts, allowed = allowedLabelPlaceholders()): string[] {
	const out: string[] = [];
	for (const label of facts.labels) {
		if (!label.name.startsWith(REASON_LABEL_PREFIX)) continue;
		for (const match of label.value.matchAll(/\$\{(\w+)\}/g)) {
			if (!allowed.has(match[1] as string)) {
				out.push(
					`${facts.name}: ${label.name} (${label.lang}) uses \${${match[1]}} — only ${[...allowed].map((name) => `\${${name}}`).join(', ')} can be filled (the details an opted-in code declares); put a fixed limit in the text`,
				);
			}
		}
		if (label.value.includes('%s')) {
			out.push(
				`${facts.name}: ${label.name} (${label.lang}) uses %s — a tool refusal label is filled by \${name} only`,
			);
		}
	}
	return out;
}

/** All static legs over one tool. */
function toolViolations(facts: ToolFacts): string[] {
	return [
		...declarationViolations(facts),
		...literalViolations(facts),
		...missingLabelViolations(facts),
		...deadLabelViolations(facts),
		...embedderViolations(facts),
		...placeholderViolations(facts),
	];
}

/** A tool's labels from its register.json — the authoring `labels` array, else the v6 dump's dd1372. */
function registerLabels(registerJson: unknown): LabelEntry[] {
	const record = (registerJson ?? {}) as {
		labels?: unknown;
		misc?: { dd1372?: { value?: unknown }[] };
	};
	const raw = Array.isArray(record.labels) ? record.labels : record.misc?.dd1372?.[0]?.value;
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(entry): entry is LabelEntry =>
			typeof entry?.lang === 'string' &&
			typeof entry?.name === 'string' &&
			typeof entry?.value === 'string',
	);
}

/**
 * The tool server trees, from the registered write-path corpus (src + tools +
 * scripts, non-test `.ts`): tool name → path → comment-stripped source. The tool
 * list is the corpus's `tools/<tool>/server/index.ts` entries.
 */
const SERVER_FILE = /^tools\/(tool_[a-z0-9_]+)\/server\/.+\.ts$/;
function serverTrees(): Map<string, Record<string, string>> {
	const trees = new Map<string, Record<string, string>>();
	for (const path of writePathSourceFiles()) {
		const tool = SERVER_FILE.exec(path)?.[1];
		if (tool === undefined || path.endsWith('.d.ts')) continue;
		const tree = trees.get(tool) ?? {};
		tree[path] = stripComments(readFileSync(join(REPO_ROOT, path), 'utf8'));
		trees.set(tool, tree);
	}
	return trees;
}

/** The tools with a server module (the ones that can throw a refusal), sorted. */
function serverTools(trees: ReadonlyMap<string, Record<string, string>>): string[] {
	return [...trees]
		.filter(([name, tree]) => `tools/${name}/server/index.ts` in tree)
		.map(([name]) => name)
		.sort();
}

async function realToolFacts(name: string, sources: Record<string, string>): Promise<ToolFacts> {
	const imported = (await import(join(TOOLS_DIR, name, 'server', 'index.ts'))) as {
		tool?: ToolServerModule;
	};
	const registerPath = join(TOOLS_DIR, name, 'register.json');
	const register = existsSync(registerPath) ? JSON.parse(readFileSync(registerPath, 'utf8')) : {};
	return {
		name,
		declared: imported.tool?.reasonKeys ?? {},
		sources,
		labels: registerLabels(register),
	};
}

/** Far below the measured set (27 server tools); proves the scan saw the tool tree, not a stub. */
const SERVER_TOOL_FLOOR = 20;

describe('A. the static legs hold for every tool', () => {
	const trees = serverTrees();

	test('the scan saw the tool tree', () => {
		expect(serverTools(trees).length).toBeGreaterThanOrEqual(SERVER_TOOL_FLOOR);
	});

	test('(a)-(g): literals, labels, dead labels, grammar, embedder, publicMessage, placeholders — every tool', async () => {
		const violations: string[] = [];
		for (const name of serverTools(trees)) {
			violations.push(...toolViolations(await realToolFacts(name, trees.get(name) ?? {})));
		}
		expect(violations).toEqual([]);
	});

	test('the registry opt-in set is real and public (the fallback sentence is honest)', () => {
		expect(REASON_KEY_CODES.length).toBeGreaterThan(0);
		expect(REASON_KEY).toBe('reason_key');
		for (const code of REASON_KEY_CODES) expect(specOf(code).disclosure, code).toBe('public');
		// the placeholder set (g) is derived from the same opt-in set, not retyped
		expect([...allowedLabelPlaceholders()]).toContain('site');
		expect(allowedLabelPlaceholders().has(REASON_KEY)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// B. Runtime — a scratch fixture tool through the loader's own door
// ---------------------------------------------------------------------------

const FIXTURE = 'tool_zzreason';
const NO_CONTEXT = {} as ToolActionContext;
const NO_ADMISSION = {} as ToolAdmissionContext;

/** The sentences the fixture DECLARES — the only ones its refusals can carry. */
const BBOX_SENTENCE = 'The bounding box is not numeric.';
const DOWN_SENTENCE = 'The tile server is not answering.';
const FIXTURE_REASONS = { bad_bbox: BBOX_SENTENCE, down: DOWN_SENTENCE } as const;

/** An opted-in code and a declared key, with NO sentence of its own — the happy refusal. */
const goodRefusal = () =>
	new DedaloError('request.invalid_options', { details: { reason_key: 'bad_bbox' } });

/** A reason_key refusal on a declared key that brings a sentence of its own. */
const refusalWith = (publicMessage: string) =>
	new DedaloError('request.invalid_options', {
		details: { reason_key: 'bad_bbox' },
		publicMessage,
	});

/** An opted-in code, an undeclared key. */
const undeclaredRefusal = () =>
	new DedaloError('request.invalid_options', { details: { reason_key: 'not_declared' } });

/** A refusal with every field the guard must carry over when it supplies the sentence. */
const CONTEXTUAL_CAUSE = new Error('driver said no');
const CONTEXTUAL = new DedaloError('tool.source_unavailable', {
	message: 'log-only text',
	details: { reason_key: 'down', site: 'tiles.example.org' },
	coordinates: { tipo: 'test1' },
	retryAfterMs: 1500,
	extend: { candidates: 2 },
	cause: CONTEXTUAL_CAUSE,
});

/** A key as a request could make it: a second forged log line and an escape sequence. */
const FORGED_KEY = 'x\n[auth] auth.csrf_failed forged=1\u001b[31m';

/** A failure envelope a handler builds and RETURNS (what `ToolResponse` permits). */
const failureBody = (code: string, reason: string | undefined, message: string): ToolResponse =>
	({
		ok: false,
		request_id: 'rq-returned',
		error: {
			code,
			category: 'caller',
			message,
			label_key: 'error_fixture',
			retryable: false,
			...(reason === undefined ? {} : { details: { reason_key: reason } }),
		},
	}) as unknown as ToolResponse;

const exempt = (handler: ToolActionSpec['handler'], extra = {}): ToolActionSpec => ({
	permission: null,
	gatedInHandler: 'UNGATED — scratch fixture of the reason-key gate; nothing real is behind it.',
	handler,
	...extra,
});

/** The scratch tool: declared keys, one action per scenario, an admit hook, a route. */
function fixtureImport(overrides: Partial<ToolServerModule> = {}): { tool: ToolServerModule } {
	const throwing = (make: () => unknown) =>
		exempt(async () => {
			throw make();
		});
	const returning = (body: ToolResponse) => exempt(async () => body);
	return {
		tool: {
			name: FIXTURE,
			reasonKeys: FIXTURE_REASONS,
			apiActions: {
				declared: throwing(goodRefusal),
				declared_same_sentence: throwing(() => refusalWith(BBOX_SENTENCE)),
				foreign_sentence: throwing(() => refusalWith('Tile server said: <b>upstream text</b>')),
				undeclared: throwing(undeclaredRefusal),
				wrong_code: throwing(
					() => new DedaloError('perm.denied', { details: { reason_key: 'bad_bbox' } }),
				),
				free_text: throwing(
					() =>
						new DedaloError('request.invalid_options', {
							details: { reason_key: 'Not A Key; <img>' },
						}),
				),
				prototype_key: throwing(
					() =>
						new DedaloError('request.invalid_options', { details: { reason_key: 'constructor' } }),
				),
				forged_log: throwing(
					() => new DedaloError('request.invalid_options', { details: { reason_key: FORGED_KEY } }),
				),
				with_context: throwing(() => CONTEXTUAL),
				plain: throwing(() => new DedaloError('perm.denied')),
				untyped: throwing(() => new TypeError('driver blew up')),
				returns_declared: returning(
					failureBody('request.invalid_options', 'bad_bbox', BBOX_SENTENCE),
				),
				returns_free_text: returning(
					failureBody('request.invalid_options', 'bad_bbox', 'Totally free text from upstream!'),
				),
				returns_undeclared: returning(
					failureBody('request.invalid_options', 'Totally Free Text!', BBOX_SENTENCE),
				),
				returns_wrong_code: returning(failureBody('perm.denied', 'bad_bbox', BBOX_SENTENCE)),
				returns_forged_code: returning(failureBody('x\nforged', 'bad_bbox', BBOX_SENTENCE)),
				returns_plain_failure: returning(failureBody('perm.denied', undefined, 'No.')),
				with_admission: exempt(async () => Promise.reject(goodRefusal()), {
					admit: () => {
						throw undeclaredRefusal();
					},
				}),
				async_admission: exempt(async () => Promise.reject(goodRefusal()), {
					admit: () => Promise.resolve(),
				}),
			},
			httpRoutes: [
				{
					pathPrefix: '/dedalo/zzreason/files/',
					readPosture: { posture: 'structure_only', reason: 'fixture route — serves no records.' },
					handle: async () => {
						throw undeclaredRefusal();
					},
				},
			],
			...overrides,
		},
	};
}

/** The error an action's handler rejects with (or the value it returns). */
async function runAction(module: ToolServerModule, action: string): Promise<unknown> {
	const spec = module.apiActions[action] as ToolActionSpec;
	try {
		return await spec.handler(NO_CONTEXT);
	} catch (thrown) {
		return thrown;
	}
}

const wireOf = (thrown: unknown) =>
	toErrorEnvelope(thrown, { requestId: 'rq-reason-gate' }).body.error;

/** The `internal.invariant` an action ends in, with the original refusal as its cause. */
async function invariantOf(module: ToolServerModule, action: string): Promise<DedaloError> {
	const thrown = (await runAction(module, action)) as DedaloError;
	expect(thrown, action).toBeInstanceOf(DedaloError);
	expect(thrown.code, action).toBe('internal.invariant');
	return thrown;
}

describe('B. the loader guard enforces the closed map at runtime', () => {
	const served = admitToolModule(fixtureImport(), FIXTURE);

	test('a declared key reaches the wire with the DECLARED sentence — the throw carries none', async () => {
		const thrown = await runAction(served, 'declared');
		expect(thrown).toBeInstanceOf(DedaloError);
		expect((thrown as DedaloError).code).toBe('request.invalid_options');
		const wire = wireOf(thrown);
		expect(wire.details).toEqual({ reason_key: 'bad_bbox' });
		expect(wire.message).toBe(BBOX_SENTENCE);
		expect(wire.label_key).toBe('error_request_invalid_options');
		// a throw that restates exactly the declared sentence is the same refusal
		const same = await runAction(served, 'declared_same_sentence');
		expect((same as DedaloError).code).toBe('request.invalid_options');
		expect(wireOf(same).message).toBe(BBOX_SENTENCE);
	});

	test('supplying the sentence changes nothing else: code, details, coordinates, cause, retry, extend, stack', async () => {
		const thrown = (await runAction(served, 'with_context')) as DedaloError;
		expect(thrown).not.toBe(CONTEXTUAL);
		expect(thrown.code).toBe('tool.source_unavailable');
		expect(thrown.message).toBe('log-only text');
		expect(thrown.details).toEqual(CONTEXTUAL.details);
		expect(thrown.coordinates).toEqual(CONTEXTUAL.coordinates);
		expect(thrown.retryAfterMs).toBe(1500);
		expect(thrown.extend).toEqual({ candidates: 2 });
		expect(thrown.cause).toBe(CONTEXTUAL_CAUSE);
		expect(thrown.stack).toBe(CONTEXTUAL.stack);
		expect(thrown.publicMessage).toBe(DOWN_SENTENCE);
		const wire = wireOf(thrown);
		expect(wire.message).toBe(DOWN_SENTENCE);
		expect(wire.details).toEqual({ reason_key: 'down', site: 'tiles.example.org' });
	});

	test('an undeclared key is internal.invariant — loud, and it never reaches the wire', async () => {
		const thrown = await invariantOf(served, 'undeclared');
		expect((thrown.cause as DedaloError).code).toBe('request.invalid_options');
		expect(thrown.message).toContain(`${FIXTURE}.undeclared`);
		expect(thrown.message).toContain('not_declared');
		expect(thrown.coordinates).toMatchObject({ tool: FIXTURE, action: 'undeclared' });
		// (the `debug` block exists only under DEDALO_DEBUG_API_ERRORS and may name it)
		const { debug: _debugOnlyUnderTheFlag, ...wire } = wireOf(thrown);
		expect(wire.code).toBe('internal.invariant');
		expect(wire.details).toBeUndefined();
		expect(JSON.stringify(wire)).not.toContain('not_declared');
	});

	test('a code that does not carry reason_key is internal.invariant (the converter would drop it silently)', async () => {
		const thrown = await invariantOf(served, 'wrong_code');
		expect(thrown.message).toContain('perm.denied');
	});

	test('a sentence of the throw that is not the declared one is internal.invariant — an upstream text is never printed', async () => {
		const thrown = await invariantOf(served, 'foreign_sentence');
		expect(thrown.message).toContain('declared');
		const wire = JSON.stringify(wireOf(thrown));
		expect(wire).not.toContain('upstream text');
		expect(wire).not.toContain('Tile server said');
	});

	test('free text can never be a key: outside the grammar is refused here and dropped by the converter', async () => {
		await invariantOf(served, 'free_text');
		// the converter's own shape guard, for a throw that bypassed the loader
		const bypass = new DedaloError('request.invalid_options', {
			details: { reason_key: 'Not A Key; <img>' },
			publicMessage: 'x',
		});
		expect(wireOf(bypass).details).toBeUndefined();
	});

	test('a key is looked up as a key, not as a property: `constructor` is undeclared unless declared', async () => {
		await invariantOf(served, 'prototype_key');
		const declaring = admitToolModule(
			fixtureImport({ reasonKeys: { constructor: 'The constructor is not available.' } }),
			FIXTURE,
		);
		const thrown = await runAction(declaring, 'prototype_key');
		expect((thrown as DedaloError).code).toBe('request.invalid_options');
		expect(wireOf(thrown).message).toBe('The constructor is not available.');
	});

	test('an offending key is echoed sanitised and bounded: no newline, no escape, no second log line', async () => {
		const thrown = await invariantOf(served, 'forged_log');
		const echoedKey = String(thrown.coordinates?.reason);
		// newline, brackets, spaces, `=` and the escape all become `?`; the dot, dash and underscore stay
		expect(echoedKey).toBe('x??auth??auth.csrf_failed?forged?1??31m');
		for (const text of [
			thrown.message,
			String(thrown.coordinates?.reason),
			formatErrorLine(thrown),
		]) {
			expect(text).not.toMatch(/\p{Cc}/u);
		}
		// one error, one line
		expect(formatErrorLine(thrown).split('\n')).toHaveLength(1);
		// a long key is cut, not echoed whole
		const long = admitToolModule(
			fixtureImport({
				apiActions: {
					long: exempt(async () =>
						Promise.reject(
							new DedaloError('request.invalid_options', {
								details: { reason_key: 'a'.repeat(5000) },
							}),
						),
					),
				},
			}),
			FIXTURE,
		);
		const cut = await invariantOf(long, 'long');
		expect(String(cut.coordinates?.reason).length).toBeLessThanOrEqual(80);
		expect(cut.message.length).toBeLessThan(600);
	});

	test('a tool that declares no reasonKeys cannot throw one', async () => {
		const undeclaring = admitToolModule(fixtureImport({ reasonKeys: undefined }), FIXTURE);
		await invariantOf(undeclaring, 'declared');
	});

	test('everything else passes through UNCHANGED (identity): no reason_key, untyped throws, results', async () => {
		const plain = (await runAction(served, 'plain')) as DedaloError;
		expect(plain.code).toBe('perm.denied');
		const untyped = await runAction(served, 'untyped');
		expect(untyped).toBeInstanceOf(TypeError);
		const sentinel = { ok: true as const, request_id: 'r', data: 7 };
		const returning = admitToolModule(
			fixtureImport({
				apiActions: { fine: { ...exempt(async () => never()), handler: async () => sentinel } },
			}),
			FIXTURE,
		);
		expect(await runAction(returning, 'fine')).toBe(sentinel);
	});

	test('a failure envelope the handler RETURNS is held to the same rule', async () => {
		// the declared key with exactly the declared sentence is the one thing that passes — by identity
		const accepted = (await runAction(served, 'returns_declared')) as { ok: boolean };
		expect(accepted.ok).toBe(false);
		expect(accepted).toBe(
			await (served.apiActions.returns_declared as ToolActionSpec).handler(NO_CONTEXT),
		);
		// free text in the message, an undeclared / free-text key, a code that does not carry the key
		for (const action of ['returns_free_text', 'returns_undeclared', 'returns_wrong_code']) {
			const thrown = await invariantOf(served, action);
			expect(thrown.message, action).toContain(`${FIXTURE}.${action} returned`);
			expect(JSON.stringify(wireOf(thrown)), action).not.toContain('free text');
		}
		// a failure with no reason_key is not this guard's business
		const plain = (await runAction(served, 'returns_plain_failure')) as { error: { code: string } };
		expect(plain.error.code).toBe('perm.denied');
		// the code of a hand-built envelope is request-derived text too: echoed sanitised
		const forged = await invariantOf(served, 'returns_forged_code');
		expect(forged.message).not.toContain('\n');
		expect(String(forged.coordinates?.code)).toBe('x?forged');
	});

	test('the admit hook is guarded; a thenable it returns is passed through for runAdmission to refuse', () => {
		const withAdmission = served.apiActions.with_admission as ToolActionSpec;
		expect(() => withAdmission.admit?.(NO_ADMISSION)).toThrow(/not_declared/);
		let caught: unknown;
		try {
			withAdmission.admit?.(NO_ADMISSION);
		} catch (thrown) {
			caught = thrown;
		}
		expect((caught as DedaloError).code).toBe('internal.invariant');
		const returned: unknown = (served.apiActions.async_admission as ToolActionSpec).admit?.(
			NO_ADMISSION,
		);
		expect(typeof (returned as { then?: unknown }).then).toBe('function');
	});

	test('a tool route handler is guarded too', async () => {
		const route = served.httpRoutes?.[0];
		expect(route).toBeDefined();
		await expect(
			route?.handle(new Request('http://x/'), '/dedalo/zzreason/files/a'),
		).rejects.toMatchObject({
			code: 'internal.invariant',
		});
	});

	test('the imported module is untouched and a second admission never double-wraps', async () => {
		const imported = fixtureImport();
		const originalHandler = imported.tool.apiActions.declared?.handler;
		const first = admitToolModule(imported, FIXTURE);
		const second = admitToolModule(imported, FIXTURE);
		expect(imported.tool.apiActions.declared?.handler).toBe(originalHandler);
		expect(first).not.toBe(imported.tool);
		expect(second.apiActions.declared?.handler).not.toBe(first.apiActions.declared?.handler);
		// one wrap deep: the cause chain of a rejected call is the original throw, not a wrapper's
		const thrown = await invariantOf(second, 'undeclared');
		expect((thrown.cause as DedaloError).code).toBe('request.invalid_options');
		expect(((thrown.cause as DedaloError).cause as unknown) ?? null).toBeNull();
	});

	test('the wrapper keeps the raw function reachable through unguarded(), and unguarded is identity otherwise', () => {
		const imported = fixtureImport();
		const guarded = admitToolModule(imported, FIXTURE);
		const raw = imported.tool.apiActions.declared as ToolActionSpec;
		const wrapped = guarded.apiActions.declared as ToolActionSpec;
		expect(wrapped.handler).not.toBe(raw.handler);
		expect(unguarded(wrapped.handler)).toBe(raw.handler);
		type AdmitHook = NonNullable<ToolActionSpec['admit']>;
		type RouteHandle = ToolHttpRoute['handle'];
		const rawAdmit = (imported.tool.apiActions.with_admission as ToolActionSpec).admit as AdmitHook;
		const servedAdmit = (guarded.apiActions.with_admission as ToolActionSpec).admit as AdmitHook;
		expect(servedAdmit).not.toBe(rawAdmit);
		expect(unguarded(servedAdmit)).toBe(rawAdmit);
		const rawHandle = imported.tool.httpRoutes?.[0]?.handle as RouteHandle;
		const servedHandle = guarded.httpRoutes?.[0]?.handle as RouteHandle;
		expect(servedHandle).not.toBe(rawHandle);
		expect(unguarded(servedHandle)).toBe(rawHandle);
		// a function nobody wrapped is returned as it is (also a module's own extractors)
		const plain = () => 1;
		expect(unguarded(plain)).toBe(plain);
		// the marker is not enumerable: it cannot leak into a spread or a serialised spec
		const [marker] = Object.getOwnPropertySymbols(wrapped.handler);
		expect(marker).toBeDefined();
		expect(Object.getOwnPropertyDescriptor(wrapped.handler, marker as symbol)?.enumerable).toBe(
			false,
		);
	});
});

describe('B. toolErrorBody — a refusal EMBEDDED in a payload gets the same check, and is logged', () => {
	const module = { name: FIXTURE, reasonKeys: FIXTURE_REASONS };

	/** `run`'s value and the first argument of every console line it caused. */
	function capture<T>(run: () => T): { value: T; lines: string[] } {
		const lines: string[] = [];
		const sinks = (['error', 'warn', 'info'] as const).map((level) =>
			spyOn(console, level).mockImplementation((...args: unknown[]) => {
				lines.push(String(args[0]));
			}),
		);
		try {
			return { value: run(), lines };
		} finally {
			for (const sink of sinks) sink.mockRestore();
		}
	}

	test('a declared key reaches the body with the DECLARED sentence', () => {
		const body = toolErrorBody(module, 'batch', goodRefusal());
		expect(body.code).toBe('request.invalid_options');
		expect(body.details).toEqual({ reason_key: 'bad_bbox' });
		expect(body.message).toBe(BBOX_SENTENCE);
	});

	test('an undeclared key, a foreign sentence, a code that does not carry the key is internal.invariant — nothing of it rides the body', () => {
		const cases = [
			undeclaredRefusal(),
			refusalWith('Tile server said: <b>upstream text</b>'),
			new DedaloError('perm.denied', { details: { reason_key: 'bad_bbox' } }),
		];
		for (const refusal of cases) {
			const { value } = capture(() => toolErrorBody(module, 'batch', refusal));
			const { debug: _underTheFlag, ...body } = value;
			expect(body.code).toBe('internal.invariant');
			expect(body.details).toBeUndefined();
			expect(JSON.stringify(body)).not.toContain('not_declared');
			expect(JSON.stringify(body)).not.toContain('upstream text');
		}
	});

	test('the refusal it replaces is LOGGED (tool, action, key) — no wrapper or dispatcher catch sees an embedded one', () => {
		const { lines } = capture(() => toolErrorBody(module, 'batch', undeclaredRefusal()));
		expect(lines).toHaveLength(1);
		const line = lines[0] as string;
		expect(line).toContain('[tools] internal.invariant');
		expect(line).toContain(`tool=${FIXTURE}`);
		expect(line).toContain('action=batch');
		expect(line).toContain('reason=not_declared');
		// the offending key is sanitised in the log line too
		const forged = capture(() =>
			toolErrorBody(
				module,
				'batch',
				new DedaloError('request.invalid_options', { details: { reason_key: FORGED_KEY } }),
			),
		);
		expect(forged.lines).toHaveLength(1);
		expect(forged.lines[0]).not.toMatch(/\p{Cc}/u);
	});

	test('an acceptable refusal and a plain one log nothing here', () => {
		const { lines } = capture(() => {
			toolErrorBody(module, 'batch', goodRefusal());
			toolErrorBody(module, 'batch', new DedaloError('perm.denied'));
		});
		expect(lines).toEqual([]);
	});

	test('a tool that declares none cannot embed one; a refusal without a key is the plain converter body', () => {
		const undeclaring = capture(() => toolErrorBody({ name: FIXTURE }, 'batch', goodRefusal()));
		expect(undeclaring.value.code).toBe('internal.invariant');
		expect(undeclaring.lines).toHaveLength(1);
		expect(toolErrorBody(module, 'batch', new DedaloError('perm.denied')).code).toBe('perm.denied');
		// an untyped throw is converted exactly as everywhere else (no driver text)
		const { debug: _underTheFlag, ...untyped } = toolErrorBody(
			module,
			'batch',
			new TypeError('driver blew up'),
		);
		expect(untyped.code.startsWith('internal.')).toBe(true);
		expect(JSON.stringify(untyped)).not.toContain('driver blew up');
	});
});

describe('B. a malformed reasonKeys declaration refuses the tool at load', () => {
	const refusal = (reasonKeys: unknown): string => {
		try {
			validateToolModule(fixtureImport({ reasonKeys: reasonKeys as never }), FIXTURE);
		} catch (thrown) {
			return (thrown as Error).message;
		}
		return '';
	};
	const sentenceRefusal = (sentence: unknown): string => refusal({ bad_bbox: sentence });

	test('a well-formed (and an absent) declaration is accepted — control', () => {
		expect(refusal(FIXTURE_REASONS)).toBe('');
		expect(refusal({})).toBe('');
		expect(refusal(undefined)).toBe('');
		// ordinary non-ASCII text, quotes and a placeholder-looking word are just text
		expect(sentenceRefusal('Ünïcödé — 日本語, "quotes", \'single\' and ${site}.')).toBe('');
	});

	test('anything but an object is refused: the retired array form, a string, null, a number', () => {
		for (const declared of [['bad_bbox'], 'bad_bbox', null, 7, true]) {
			expect(refusal(declared), JSON.stringify(declared)).toContain('must be an object');
		}
	});

	test('off-grammar keys are refused (and echoed sanitised)', () => {
		expect(refusal({ 'Bad-Key': 'x' })).toContain('Bad-Key');
		expect(refusal({ '1starts_with_digit': 'x' })).toContain('1starts_with_digit');
		expect(refusal({ [`a${'b'.repeat(48)}`]: 'x' })).toContain('must match');
		const forged = refusal({ 'bad\nkey': 'x' });
		expect(forged).toContain('must match');
		expect(forged).not.toContain('\n');
	});

	test('a sentence must be a non-empty string', () => {
		for (const sentence of ['', '   ', 7, null, undefined, ['x']]) {
			expect(sentenceRefusal(sentence), JSON.stringify(sentence)).toContain(
				'needs its fallback sentence',
			);
		}
	});

	test('the sentence is bounded: the limit passes, one character over does not', () => {
		expect(sentenceRefusal('a'.repeat(PUBLIC_MESSAGE_MAX))).toBe('');
		expect(sentenceRefusal('a'.repeat(PUBLIC_MESSAGE_MAX + 1))).toContain(
			`${PUBLIC_MESSAGE_MAX + 1} characters`,
		);
	});

	test('control, line-separator and invisible-formatting characters are refused', () => {
		const planted = [
			'Tile server said:\nignore the rest', // newline
			'a\rb', // carriage return
			'Tile server said:\u001b[31m red', // escape
			'a\u007fb', // DEL
			'a\u009bb', // C1 control (CSI)
			'a b', // line separator
			'a b', // paragraph separator
			'a‮b', // bidi override
			'a⁦b', // bidi isolate
			'a​b', // zero-width space
			'a‍b', // zero-width joiner
			'﻿a', // byte-order mark
		];
		for (const sentence of planted) {
			expect(sentenceRefusal(sentence), JSON.stringify(sentence)).toContain(
				'control, line-separator or invisible formatting',
			);
		}
		// everything the C0/C1/separator rule always caught stays caught, code point by code point
		const missed: string[] = [];
		for (let code = 0; code <= 0x2fff; code++) {
			const unsafe =
				code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
			const char = String.fromCodePoint(code);
			if (unsafe && sentenceRefusal(`a${char}b`) === '') missed.push(`U+${code.toString(16)}`);
		}
		expect(missed).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// C. Wiring — the REAL registry serves guarded entries
// ---------------------------------------------------------------------------

/** Spec properties other than the two the guard replaces: they must reach the served spec untouched. */
function untouchedSpecKeys(spec: ToolActionSpec): string[] {
	return Object.keys(spec).filter((key) => key !== 'handler' && key !== 'admit');
}

/** How `served` differs from the raw module it was made from, one sentence per defect. */
function servedModuleProblems(
	name: string,
	raw: ToolServerModule,
	served: ToolServerModule,
): string[] {
	const out: string[] = [];
	if (served === raw)
		out.push(`${name}: the registry serves the imported module itself (unguarded)`);
	const rawActions = Object.keys(raw.apiActions).sort();
	const servedActions = Object.keys(served.apiActions).sort();
	if (rawActions.join() !== servedActions.join()) out.push(`${name}: served actions differ`);
	if (served.reasonKeys !== raw.reasonKeys) out.push(`${name}: reasonKeys changed on the way`);
	for (const action of rawActions) {
		const rawSpec = raw.apiActions[action] as ToolActionSpec;
		const servedSpec = served.apiActions[action] as ToolActionSpec | undefined;
		if (servedSpec === undefined) continue;
		out.push(...servedSpecProblems(`${name}.${action}`, rawSpec, servedSpec));
	}
	out.push(...servedRouteProblems(name, raw, served));
	return out;
}

function servedSpecProblems(id: string, raw: ToolActionSpec, served: ToolActionSpec): string[] {
	const out: string[] = [];
	if (served.handler === raw.handler || unguarded(served.handler) !== raw.handler) {
		out.push(`${id}: the served handler is not a guard around the exported one`);
	}
	if (raw.admit === undefined) {
		if (served.admit !== undefined) out.push(`${id}: an admit hook appeared`);
	} else if (served.admit === undefined) {
		out.push(`${id}: the admit hook was dropped`);
	} else if (served.admit === raw.admit || unguarded(served.admit) !== raw.admit) {
		out.push(`${id}: the served admit hook is not a guard around the exported one`);
	}
	const rawFields = raw as unknown as Record<string, unknown>;
	const servedFields = served as unknown as Record<string, unknown>;
	for (const key of untouchedSpecKeys(raw)) {
		if (!Object.is(servedFields[key], rawFields[key])) out.push(`${id}: ${key} changed`);
	}
	return out;
}

function servedRouteProblems(
	name: string,
	raw: ToolServerModule,
	served: ToolServerModule,
): string[] {
	const rawRoutes = raw.httpRoutes ?? [];
	const servedRoutes = served.httpRoutes ?? [];
	if (rawRoutes.length !== servedRoutes.length) return [`${name}: served routes differ`];
	const out: string[] = [];
	rawRoutes.forEach((route, index) => {
		const servedRoute = servedRoutes[index] as (typeof servedRoutes)[number];
		const id = `${name} route ${route.pathPrefix}`;
		if (servedRoute.handle === route.handle || unguarded(servedRoute.handle) !== route.handle) {
			out.push(`${id}: the served handle is not a guard around the exported one`);
		}
		if (
			servedRoute.pathPrefix !== route.pathPrefix ||
			servedRoute.readPosture !== route.readPosture
		) {
			out.push(`${id}: prefix or read posture changed`);
		}
	});
	return out;
}

describe('C. the real registry serves a guard around every exported handler, hook and route', () => {
	test('scan → registry → served: no loaded tool runs a handler, admit hook or route unguarded', async () => {
		const registry = await loadToolModules();
		const problems: string[] = [];
		let handlers = 0;
		let admits = 0;
		let routes = 0;
		for (const [name, loaded] of registry) {
			// the loader's own specifier: the canonical path, so the SAME module instance
			const entry = realpathSync(join(loaded.dir, 'server', 'index.ts'));
			const raw = ((await import(entry)) as { tool: ToolServerModule }).tool;
			problems.push(...servedModuleProblems(name, raw, loaded.module));
			handlers += Object.keys(raw.apiActions).length;
			admits += Object.values(raw.apiActions).filter((spec) => spec.admit !== undefined).length;
			routes += raw.httpRoutes?.length ?? 0;
		}
		expect(problems).toEqual([]);
		// anti-vacuity: the walk saw the registry (27 tools, 89 actions, 2 hooks, 1 route on 2026-11-06)
		expect(registry.size).toBeGreaterThanOrEqual(SERVER_TOOL_FLOOR);
		expect(handlers).toBeGreaterThanOrEqual(60);
		expect(admits).toBeGreaterThanOrEqual(1);
		expect(routes).toBeGreaterThanOrEqual(1);
	});

	test('the matcher fires on a registry that serves the exported module, or a spec the guard did not wrap', () => {
		const imported = fixtureImport().tool;
		const guarded = admitToolModule({ tool: imported }, FIXTURE);
		expect(servedModuleProblems(FIXTURE, imported, guarded)).toEqual([]);
		// the unguarded module itself
		expect(servedModuleProblems(FIXTURE, imported, imported).length).toBeGreaterThan(0);
		// one handler left raw among wrapped ones
		const oneRaw: ToolServerModule = {
			...guarded,
			apiActions: {
				...guarded.apiActions,
				declared: imported.apiActions.declared as ToolActionSpec,
			},
		};
		expect(servedModuleProblems(FIXTURE, imported, oneRaw)).toEqual([
			`${FIXTURE}.declared: the served handler is not a guard around the exported one`,
		]);
		// a route left raw
		const rawRoute: ToolServerModule = { ...guarded, httpRoutes: imported.httpRoutes ?? [] };
		expect(servedModuleProblems(FIXTURE, imported, rawRoute)).toHaveLength(1);
		// a wrapper that drops the admit hook, or invents one
		const { admit: _dropped, ...withoutAdmit } = guarded.apiActions
			.with_admission as ToolActionSpec;
		const noAdmit: ToolServerModule = {
			...guarded,
			apiActions: { ...guarded.apiActions, with_admission: withoutAdmit as ToolActionSpec },
		};
		expect(servedModuleProblems(FIXTURE, imported, noAdmit)).toEqual([
			`${FIXTURE}.with_admission: the admit hook was dropped`,
		]);
	});

	test('client wiring: the tool is stamped before api_error is published, and a built tool registers its labels', () => {
		const dataManager = stripComments(
			readFileSync(join(REPO_ROOT, 'client/dedalo/core/common/js/data_manager.js'), 'utf8'),
		);
		const stamp = dataManager.indexOf('api_error.tool = request_tool(body)');
		expect(stamp, 'data_manager stamps ApiError.tool from the request body').toBeGreaterThan(0);
		const publish = dataManager.indexOf("event_manager.publish('api_error', api_error)", stamp);
		expect(publish, 'a failure publish follows the stamp').toBeGreaterThan(stamp);
		// nothing asynchronous sits between the stamp and the publish the page subscriber toasts on
		expect(dataManager.slice(stamp, publish)).not.toContain('await ');

		const toolCommon = stripComments(
			readFileSync(join(REPO_ROOT, 'client/dedalo/core/tools_common/js/tool_common.js'), 'utf8'),
		);
		expect(toolCommon).toContain(
			"import {register_tool_error_labels} from '../../../core/common/js/render_api_error.js'",
		);
		expect(toolCommon).toContain('register_tool_error_labels(self.model, self.context?.labels)');

		const renderer = stripComments(
			readFileSync(join(REPO_ROOT, 'client/dedalo/core/common/js/render_api_error.js'), 'utf8'),
		);
		const reason = renderer.indexOf('tool_reason_text(api_error, details)');
		const core = renderer.indexOf('labels[api_error.label_key]');
		expect(reason, 'error_text asks the tool first').toBeGreaterThan(0);
		expect(core).toBeGreaterThan(reason);
	});
});

// ---------------------------------------------------------------------------
// D. Anti-vacuity — every static matcher fires on a planted offender
// ---------------------------------------------------------------------------

describe('D. anti-vacuity — each leg goes red on its planted offender', () => {
	const eng = (name: string, value = 'text'): LabelEntry => ({ lang: 'lg-eng', name, value });
	const server = (code: string): Record<string, string> => ({
		'tools/tool_zzplanted/server/index.ts': code,
	});
	const clean: ToolFacts = {
		name: 'tool_zzplanted',
		declared: { bad_bbox: 'The box is not numeric.' },
		sources: server(
			"throw new DedaloError('request.invalid_options', { details: { reason_key: 'bad_bbox' } });",
		),
		labels: [eng('reason_bad_bbox')],
	};

	test('control: a clean tool is clean', () => {
		expect(toolViolations(clean)).toEqual([]);
	});

	test('(a) an undeclared literal — in any spelling of the quote — is red', () => {
		for (const literal of ["'surprise'", '"surprise"', '`surprise`']) {
			const planted: ToolFacts = {
				...clean,
				sources: { 'tools/tool_zzplanted/server/more.ts': `x({ reason_key: ${literal} });` },
			};
			expect(literalViolations(planted), literal).toHaveLength(1);
		}
		// …and a tool that declares nothing but throws one
		expect(literalViolations({ ...clean, declared: {} })).toHaveLength(1);
		// a property READ is not a write
		expect(reasonKeyLiterals('const k = error.details.reason_key; k === "x"')).toEqual([]);
	});

	test('(b) a missing label is red per declared key and per language the tool is translated into', () => {
		const noLabel = { ...clean, labels: [] };
		expect(missingLabelViolations(noLabel)).toEqual([
			'tool_zzplanted: no reason_bad_bbox label in lg-eng',
		]);
		const spanishUi: ToolFacts = {
			...clean,
			labels: [eng('reason_bad_bbox'), { lang: 'lg-spa', name: 'save_button', value: 'Guardar' }],
		};
		expect(missingLabelViolations(spanishUi)).toEqual([
			'tool_zzplanted: no reason_bad_bbox label in lg-spa',
		]);
		expect(
			missingLabelViolations({ ...clean, labels: [eng('reason_bad_bbox', '  ')] }),
		).toHaveLength(1);
		// a tool that declares none owes no labels
		expect(missingLabelViolations({ ...clean, declared: {}, labels: [] })).toEqual([]);
	});

	test('(c) a dead reason_* label is red', () => {
		const dead: ToolFacts = { ...clean, labels: [eng('reason_bad_bbox'), eng('reason_stale')] };
		expect(deadLabelViolations(dead)).toEqual([
			'tool_zzplanted: dead label reason_stale (lg-eng) — no declared reason key',
		]);
		expect(deadLabelViolations({ ...clean, declared: {}, labels: [eng('reason_x')] })).toHaveLength(
			1,
		);
		// a UI label that merely contains the word is not one
		expect(
			deadLabelViolations({ ...clean, labels: [eng('reason_bad_bbox'), eng('why_reason')] }),
		).toEqual([]);
	});

	test("(d) an invalid declaration is red: the loader's own check, so the gate and the door cannot disagree", () => {
		expect(declarationViolations({ ...clean, declared: { 'Bad Key': 'x' } })).toHaveLength(1);
		expect(declarationViolations({ ...clean, declared: { bad_bbox: '' } })).toHaveLength(1);
		expect(declarationViolations({ ...clean, declared: { bad_bbox: 'a\u202eb' } })).toHaveLength(1);
		expect(
			declarationViolations({
				...clean,
				declared: { bad_bbox: 'x'.repeat(PUBLIC_MESSAGE_MAX + 1) },
			}),
		).toHaveLength(1);
		// the retired array form is not a declaration
		expect(
			declarationViolations({
				...clean,
				declared: ['bad_bbox'] as unknown as Record<string, string>,
			}),
		).toHaveLength(1);
		expect(declarationViolations(clean)).toEqual([]);
		expect(declarationViolations({ ...clean, declared: {} })).toEqual([]);
	});

	test('(e) every body builder is red in a tool that declares keys, however it is spelled; toolErrorBody is not', () => {
		for (const builder of BODY_BUILDERS) {
			const spellings = [
				`return { uri, error: ${builder}(e) };`, // a call
				`import { ${builder} } from '../../../src/core/errors/index.ts';`, // an import
				`import { ${builder} as body } from '../../../src/core/errors/index.ts';`, // an aliased import
				`import {\n\tDedaloError,\n\t${builder} as body,\n} from 'x';`, // a multi-line import
				`return { uri, ...errors.${builder}(e) };`, // a namespace member
				`const { ${builder}: build } = errors;`, // a destructure alias
				`return errors['${builder}'](e);`, // computed access
				`return errors["${builder}"](e);`,
			];
			for (const spelling of spellings) {
				const planted: ToolFacts = { ...clean, sources: server(spelling) };
				expect(embedderViolations(planted), `${builder}: ${spelling}`).toHaveLength(1);
			}
		}
		const embedded: ToolFacts = {
			...clean,
			sources: server("return { uri, error: toolErrorBody(tool, 'import', e) };"),
		};
		expect(embedderViolations(embedded)).toEqual([]);
		// a tool that declares nothing keeps its direct calls (no key can ride them)
		expect(
			embedderViolations({ ...clean, declared: {}, sources: server('return toErrorBody(e);') }),
		).toEqual([]);
		// a sentence that merely names the function is not a use of it, and neither is a longer identifier
		expect(
			embedderViolations({
				...clean,
				sources: server(
					"const why = 'toErrorBody(e) is banned'; const toErrorBodyCount = 1; myToStreamFrame(e);",
				),
			}),
		).toEqual([]);
	});

	test('(e) the builder list is complete: every function convert.ts exports is a builder or named as not one', () => {
		const exported = Object.entries(converter)
			.filter(([, value]) => typeof value === 'function')
			.map(([name]) => name)
			.sort();
		const classified = [...BODY_BUILDERS, ...NOT_BODY_BUILDERS].sort();
		// a new export is red until someone decides which side it is on; a stale name is red too
		expect(exported).toEqual(classified);
		// …and the five builders really do end in the converter's body (each carries details.reason_key)
		const refusal = new DedaloError('request.invalid_options', {
			details: { reason_key: 'bad_bbox' },
			publicMessage: 'x',
		});
		const bodies = [
			converter.toErrorBody(refusal),
			converter.toErrorEnvelope(refusal, { requestId: 'r' }).body.error,
			converter.toStructuredErr(refusal).error,
			converter.toFailureRecord(refusal).error,
			converter.toStreamFrame(refusal).error,
		];
		expect(bodies).toHaveLength(BODY_BUILDERS.length);
		for (const body of bodies) expect(body.details).toEqual({ reason_key: 'bad_bbox' });
	});

	test('(g) a reason label placeholder nobody fills, or a %s, is red', () => {
		const allowed = new Set(['site']);
		const labelled = (value: string): ToolFacts => ({
			...clean,
			labels: [eng('reason_bad_bbox', value)],
		});
		expect(placeholderViolations(labelled('Cannot reach ${site}'), allowed)).toEqual([]);
		expect(placeholderViolations(labelled('At most ${max} items'), allowed)).toHaveLength(1);
		expect(
			placeholderViolations(labelled('Cannot reach ${site} or ${other}'), allowed),
		).toHaveLength(1);
		expect(placeholderViolations(labelled('Bad value %s'), allowed)).toHaveLength(1);
		// a UI label (not reason_*) may use whatever the tool's own renderer fills
		expect(
			placeholderViolations(
				{ ...clean, labels: [eng('save_title', 'Save ${count} items, %s')] },
				allowed,
			),
		).toEqual([]);
		// the live set is the derived one
		expect(placeholderViolations(labelled('At most ${max} items'))).toHaveLength(1);
		expect(placeholderViolations(labelled('Cannot reach ${site}'))).toEqual([]);
	});

	test('register.json labels are read from both formats (authoring labels[], v6 dump dd1372)', () => {
		const entry = { lang: 'lg-eng', name: 'reason_x', value: 'X' };
		expect(registerLabels({ labels: [entry] })).toEqual([entry]);
		expect(registerLabels({ misc: { dd1372: [{ id: 1, value: [entry] }] } })).toEqual([entry]);
		expect(registerLabels({ labels: [entry, { lang: 1 }] })).toEqual([entry]);
		expect(registerLabels({})).toEqual([]);
		expect(registerLabels(null)).toEqual([]);
	});

	test('the corpus lister saw tool server sources (the per-tool trees are not empty)', () => {
		const trees = serverTrees();
		expect(trees.size).toBeGreaterThanOrEqual(SERVER_TOOL_FLOOR);
		for (const path of Object.keys(trees.get('tool_dev_template') ?? {})) {
			expect(SERVER_FILE.test(path), path).toBe(true);
		}
		expect(Object.keys(trees.get('tool_dev_template') ?? {})).toContain(
			'tools/tool_dev_template/server/index.ts',
		);
	});
});

/** A handler body that must never run (types only). */
function never(): never {
	throw new Error('unreachable');
}
