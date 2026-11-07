/**
 * TOOL READ-ONLY ACTION TRIPWIRE — a tool action that DECLARES `readOnly: true`
 * cannot reach one of the ENUMERATED write doors (the matrix writers incl. the
 * item-id counters, the activity and update rows, the Time Machine writers and
 * the job manager). Media files, other stores and a psql child are NOT policed
 * — see HONEST LIMITS below.
 *
 * WHAT THE DECLARATION BUYS, AND WHY IT MUST BE POLICED. `readOnly` on a
 * `ToolActionSpec` (src/core/tools/module.ts) takes the action's `tool_request`
 * off the idempotency ledger (api/dispatch.ts Gate 4): a stamped RESEND of it
 * re-executes instead of being replayed, so its real outcome — an upstream
 * `external.http_status` — reaches the operator instead of being masked by
 * `idempotency.outcome_unknown`. That is lawful only for an action that writes
 * nothing; a wrong declaration on a writer is CLI-01 reintroduced (a duplicate
 * heritage record, minted by the transport's own resend). So the declaration is
 * policed on three independent legs, because none alone is enough:
 *
 *  1. THE DECLARATION (loader). `validateToolModule` refuses a `readOnly` that is
 *     not the literal `true`, one on a `backgroundRunnable` action (a job is a
 *     write), and a level-gated one that does not spell EXACTLY `minLevel: 1`
 *     (the gated default is 2, write; 0, a negative or NaN pass the gates'
 *     `level < required` comparison for everyone, i.e. no level gate at all).
 *     Driven here on synthetic modules, both ways.
 *
 *  2. THE STATIC WALK. For every readOnly action of every LOADED tool module
 *     (derived, never listed), the unit `tools/<tool>/server/index.ts#
 *     tool.apiActions.<action>` — the action's own span, handler included — must
 *     NOT be a member of the writer closure (test/helpers/matrix_writer_closure.ts:
 *     a declaration with an import-resolved path to a raw `matrix_write.ts` DML
 *     primitive or an off-home psql writer, chokepoints included) and must not
 *     reach the doors the closure does not seed: the activity / update-row
 *     writers, the item-id counter writers, the Time Machine writers and the job
 *     manager. The activity writer's only emitter, `logActivity`, is named too
 *     (it calls `insertMatrixRowSequenceId`, which its runtime refusal swallows —
 *     see leg 3). An action the walk cannot SEE (not a literal key of
 *     `tool.apiActions`) is itself an offender — an unanalysable claim is no
 *     claim. The analyser and the judge run on injected corpora (positive
 *     controls), so the floor is EXECUTED even though the real corpus holds one
 *     declaration (the exemplar's `read_demo`).
 *
 *  3. THE RUNTIME SCOPE. The dispatcher runs a readOnly handler inside
 *     security/read_only_scope.ts, and every door that stamps a record, a
 *     history row, an activity row or a job refuses there as `internal.invariant`.
 *     A static walk cannot see a dynamic dispatch or a computed `import()`; this
 *     leg is what catches those. The guarded set is DERIVED from the writer home
 *     (every matrix_write.ts DML primitive — a new one is red until guarded —
 *     plus the classified non-primitive writers beside them: the activity and
 *     update-row writers and the two item-id counter UPDATEs; a non-DML export
 *     whose body carries INSERT / UPDATE / DELETE is red until it is in that
 *     list, so the classification made for a different question — "is this a
 *     component VALUE write" — cannot hide a real write), and each door is
 *     CALLED in the scope with garbage arguments: a guard that is not the FIRST
 *     statement lets the argument check answer instead and the refusal text
 *     names the wrong thing. THERE IS NO ESCAPE HATCH: a job never inherits the
 *     scope (submit refuses inside it; a QUEUED job resumes in the context its
 *     own submit captured), driven here with a job whose lane slot is freed from
 *     inside the scope. THE ACTIVITY DOOR REFUSES, BUT QUIETLY: `logActivity`
 *     swallows every failure by design (an audit write must never fail the user
 *     action), so inside the scope the row is dropped and the refusal is a
 *     logged line, not a thrown error — pinned below as the documented outcome;
 *     what catches an action that logs activity is the static walk (leg 2).
 *     The dispatcher half — the handler really runs inside the scope iff it
 *     declares readOnly, and a write attempt through the real dispatcher is
 *     refused — is client_idempotency_tripwire block H (it needs the tool grant,
 *     i.e. the DB).
 *
 * HONEST LIMITS. The static walk reads import-resolved references (see the
 * closure's own header for what it does not see: `this.x()`, property dispatch,
 * a computed `import()`); the runtime scope does not cover a psql child process,
 * a raw `fs` write into the media tree (about 40 call sites, no single write
 * door to guard or seed), DML OUTSIDE matrix_write.ts on other stores — the
 * off-home ledger of sql_confinement_tripwire and the T4 owners: user stats,
 * locks, queues, the ontology, the derived search tables, none of which the
 * writer closure seeds — or the lazily consumed body of a streamed response (its
 * pulls run outside the handler's async tree). A readOnly action that touches
 * one of those breaks its declaration and NOTHING here refuses it: that part of
 * the claim is the author's attestation, and every statement of the claim
 * (module.ts, TOOLS_SPEC, the tool docs) says so. Both halves together are the
 * proof of the enumerated doors; neither claims more than it checks.
 *
 * TIER: hermetic — no database. The doors refuse before any SQL.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { logActivity } from '../../src/core/api/handlers/activity_log.ts';
import * as matrixWrite from '../../src/core/db/matrix_write.ts';
import * as timeMachine from '../../src/core/db/time_machine.ts';
import { isDedaloError } from '../../src/core/errors/dedalo_error.ts';
import { type JobWorker, MediaJobManager, mediaJobs } from '../../src/core/media/jobs.ts';
import * as readOnlyScope from '../../src/core/security/read_only_scope.ts';
import {
	assertNotReadOnlyRequest,
	inReadOnlyScope,
	runReadOnly,
} from '../../src/core/security/read_only_scope.ts';
import { loadToolModules, validateToolModule } from '../../src/core/tools/loader.ts';
import type { ToolServerModule } from '../../src/core/tools/module.ts';
import {
	buildWriterClosure,
	MATRIX_WRITE,
	MATRIX_WRITE_NON_DML,
	RAW_PRIMITIVES,
	topLevelBlocks,
	type WriterClosure,
} from '../helpers/matrix_writer_closure.ts';
import { stripComments } from '../helpers/strip_comments.ts';
import { WRITE_PATH_CORPUS_FLOOR } from '../helpers/write_path_corpus.ts';

const REPO_ROOT = join(import.meta.dir, '..', '..');

// ---------------------------------------------------------------------------
// Leg 2 — the static walk, as a function of (closure, declared actions)
// ---------------------------------------------------------------------------

/**
 * Doors the closure does not seed but whose reach a read-only action must not
 * have: the activity / update-row writers and the item-id counter writers
 * (classified non-DML in the closure helper because they are not CURATED record
 * VALUES — but they ARE rows, and a counter UPDATE changes the end state of a
 * resend), the Time Machine writers and the job manager (a job is a write).
 * `logActivity` is the activity writer's only emitter and swallows the runtime
 * refusal, so this walk is the only thing that names a caller of it.
 */
const EXTRA_WRITE_DOORS: Readonly<Record<string, string>> = {
	'src/core/db/matrix_write.ts#insertMatrixRowSequenceId': 'an activity row',
	'src/core/db/matrix_write.ts#appendMatrixUpdateRow': 'an update-process row',
	'src/core/db/matrix_write.ts#allocateComponentItemId':
		'an item-id counter UPDATE (a resend would burn another id)',
	'src/core/db/matrix_write.ts#absorbComponentItemIds': 'an item-id counter UPDATE',
	'src/core/db/time_machine.ts#recordTimeMachine': 'a Time Machine row',
	'src/core/db/time_machine.ts#recordBulkPair': 'a Time Machine bulk pair',
	'src/core/db/time_machine.ts#recordBulkBirth': 'a Time Machine birth row',
	'src/core/db/time_machine.ts#recordBulkCascadeDelete': 'a Time Machine cascade-delete row',
	'src/core/media/jobs.ts#mediaJobs': 'the job manager (a job is a write)',
	'src/core/api/handlers/activity_log.ts#logActivity':
		'the activity log emitter (an activity row; its runtime refusal is swallowed by design, so only this walk catches a caller)',
};

interface DeclaredReadOnly {
	tool: string;
	action: string;
	/** Repo-relative server entry the action's literal key must live in. */
	file: string;
}

/** The analysis unit of one declaration: the action's own span in `tool.apiActions`. */
const unitOf = (declared: DeclaredReadOnly): string =>
	`${declared.file}#tool.apiActions.${declared.action}`;

/**
 * Every declaration that breaks the claim, as a sentence. THE judge: the real
 * run and the injected controls both go through it.
 */
function writeDoorOffenders(
	closure: WriterClosure,
	declarations: readonly DeclaredReadOnly[],
): string[] {
	const offenders: string[] = [];
	for (const declared of declarations) {
		const label = `${declared.tool}.${declared.action}`;
		const unit = unitOf(declared);
		if (!closure.bodies.has(unit)) {
			offenders.push(
				`${label}: not statically analysable — declare it as a LITERAL key of \`export const tool = { apiActions: { ${declared.action}: { … } } }\` in ${declared.file} (an action built elsewhere cannot be walked, so its readOnly claim cannot be proven)`,
			);
			continue;
		}
		if (closure.members.has(unit)) {
			offenders.push(
				`${label}: reaches a matrix writer — ${closure.witness(unit).join(' → ')}. A read-only action must not write; drop its readOnly declaration or the write.`,
			);
		}
		for (const [door, what] of Object.entries(EXTRA_WRITE_DOORS)) {
			if (closure.reaches(unit, door)) offenders.push(`${label}: reaches ${door} (${what})`);
		}
	}
	return offenders;
}

describe('LEG 2 — the static walk over the real corpus', () => {
	test('every readOnly action of every loaded tool module cannot reach a write door', async () => {
		const registry = await loadToolModules();
		// the walk's own floor: a registry that loaded nothing is a broken load
		expect(registry.size).toBeGreaterThan(10);

		const declarations: DeclaredReadOnly[] = [];
		for (const [tool, loaded] of registry) {
			for (const [action, spec] of Object.entries(loaded.module.apiActions)) {
				if (spec.readOnly === undefined) continue;
				// the loader already refused anything but the literal true; re-read here so
				// a loader regression cannot leave a truthy-but-not-true flag unexamined
				expect(spec.readOnly, `${tool}.${action}`).toBe(true);
				expect(loaded.module.backgroundRunnable ?? [], `${tool}.${action}`).not.toContain(action);
				declarations.push({
					tool,
					action,
					file: relative(REPO_ROOT, join(loaded.dir, 'server', 'index.ts')),
				});
			}
		}
		// THE EXEMPLAR IS A REAL DECLARATION, so the walk below is executed on the
		// real corpus and not only on the injected controls (gate_vacuity)
		expect(declarations.map((entry) => `${entry.tool}.${entry.action}`)).toContain(
			'tool_dev_template.read_demo',
		);

		const closure = buildWriterClosure();
		expect(closure.files.length).toBeGreaterThanOrEqual(WRITE_PATH_CORPUS_FLOOR);
		expect(writeDoorOffenders(closure, declarations)).toEqual([]);
	});

	test('every extra write door is a LIVE unit of the real closure (a rename cannot make it a dead key)', () => {
		const closure = buildWriterClosure();
		for (const door of Object.keys(EXTRA_WRITE_DOORS)) {
			expect(
				closure.bodies.has(door),
				`${door} is not a unit of the corpus — renamed, moved or deleted? An extra door that names nothing polices nothing.`,
			).toBe(true);
		}
	});
});

describe('LEG 2 — the analyser and the judge, on injected corpora (positive controls)', () => {
	const MATRIX_WRITE_CONTROL = [
		'export async function updateMatrixKeyData(t: string): Promise<void> {',
		'\tawait sql`x`;',
		'}',
		'export async function insertMatrixRowSequenceId(): Promise<number> {',
		'\treturn 1;',
		'}',
		'export async function appendMatrixUpdateRow(): Promise<void> {}',
		'export async function allocateComponentItemId(): Promise<number> {',
		'\treturn 1;',
		'}',
		'export async function absorbComponentItemIds(): Promise<void> {}',
	].join('\n');
	const ACTIVITY_CONTROL = [
		"import { insertMatrixRowSequenceId } from '../../db/matrix_write.ts';",
		'export async function logActivity(): Promise<void> {',
		'\tawait insertMatrixRowSequenceId();',
		'}',
	].join('\n');
	const TIME_MACHINE_CONTROL = [
		'export async function recordTimeMachine(): Promise<void> {}',
		'export async function recordBulkPair(): Promise<void> {}',
		'export async function recordBulkBirth(): Promise<void> {}',
		'export async function recordBulkCascadeDelete(): Promise<void> {}',
	].join('\n');
	const JOBS_CONTROL = 'export const mediaJobs = { submit(): void {} };';
	const ENGINE = [
		"import { updateMatrixKeyData } from '../core/db/matrix_write.ts';",
		'export async function zzSave(): Promise<void> {',
		"\tawait updateMatrixKeyData('matrix');",
		'}',
		'export async function zzPure(): Promise<number> {',
		'\treturn 1;',
		'}',
	].join('\n');
	const TOOL = [
		"import { insertMatrixRowSequenceId, appendMatrixUpdateRow, updateMatrixKeyData, allocateComponentItemId, absorbComponentItemIds } from '../../../src/core/db/matrix_write.ts';",
		"import { logActivity } from '../../../src/core/api/handlers/activity_log.ts';",
		"import { recordTimeMachine, recordBulkPair, recordBulkBirth, recordBulkCascadeDelete } from '../../../src/core/db/time_machine.ts';",
		"import { mediaJobs } from '../../../src/core/media/jobs.ts';",
		"import { zzPure, zzSave } from '../../../src/zz/engine.ts';",
		'async function pureHandler(): Promise<number> {',
		'\treturn zzPure();',
		'}',
		'async function viaEngine(): Promise<void> {',
		'\tawait zzSave();',
		'}',
		'async function activity(): Promise<void> {',
		'\tawait insertMatrixRowSequenceId();',
		'}',
		'export const tool = {',
		"\tname: 'zz_ro',",
		'\tapiActions: {',
		'\t\tclean_inline: { permission: null, readOnly: true, handler: async () => zzPure() },',
		'\t\tclean_named: { permission: null, readOnly: true, handler: pureHandler },',
		'\t\twrite_inline: {',
		'\t\t\tpermission: null,',
		'\t\t\treadOnly: true,',
		"\t\t\thandler: async () => updateMatrixKeyData('matrix'),",
		'\t\t},',
		'\t\twrite_transitive: { permission: null, readOnly: true, handler: viaEngine },',
		'\t\twrite_activity: { permission: null, readOnly: true, handler: activity },',
		'\t\twrite_update_row: { permission: null, readOnly: true, handler: async () => appendMatrixUpdateRow() },',
		'\t\twrite_history: { permission: null, readOnly: true, handler: async () => recordTimeMachine() },',
		'\t\twrite_bulk_pair: { permission: null, readOnly: true, handler: async () => recordBulkPair() },',
		'\t\twrite_bulk_birth: { permission: null, readOnly: true, handler: async () => recordBulkBirth() },',
		'\t\twrite_cascade: {',
		'\t\t\tpermission: null,',
		'\t\t\treadOnly: true,',
		'\t\t\thandler: async () => recordBulkCascadeDelete(),',
		'\t\t},',
		'\t\twrite_job: { permission: null, readOnly: true, handler: async () => mediaJobs.submit() },',
		'\t\twrite_counter_allocate: {',
		'\t\t\tpermission: null,',
		'\t\t\treadOnly: true,',
		'\t\t\thandler: async () => allocateComponentItemId(),',
		'\t\t},',
		'\t\twrite_counter_absorb: {',
		'\t\t\tpermission: null,',
		'\t\t\treadOnly: true,',
		'\t\t\thandler: async () => absorbComponentItemIds(),',
		'\t\t},',
		'\t\twrite_log_activity: {',
		'\t\t\tpermission: null,',
		'\t\t\treadOnly: true,',
		'\t\t\thandler: async () => logActivity(),',
		'\t\t},',
		'\t\t// the sibling that writes is NOT declared read-only and must not taint the others',
		'\t\tsibling_writer: { permission: null, handler: viaEngine },',
		'\t},',
		'};',
	].join('\n');
	// the injected corpus sits at the production paths of the real doors
	const FILES: Record<string, string> = {
		[MATRIX_WRITE]: MATRIX_WRITE_CONTROL,
		'src/core/api/handlers/activity_log.ts': ACTIVITY_CONTROL,
		'src/core/db/time_machine.ts': TIME_MACHINE_CONTROL,
		'src/core/media/jobs.ts': JOBS_CONTROL,
		'src/zz/engine.ts': ENGINE,
		'tools/zz_ro/server/index.ts': TOOL,
	};
	const closure = buildWriterClosure({
		files: Object.keys(FILES),
		read: (rel) => FILES[rel] as string,
	});
	const declared = (action: string): DeclaredReadOnly => ({
		tool: 'zz_ro',
		action,
		file: 'tools/zz_ro/server/index.ts',
	});

	test('the clean actions are clean — inline handler and named handler alike', () => {
		expect(
			writeDoorOffenders(closure, [declared('clean_inline'), declared('clean_named')]),
		).toEqual([]);
	});

	test('every kind of write door is found, each by its own action', () => {
		const expectations: Record<string, string> = {
			write_inline: 'reaches a matrix writer',
			write_transitive: 'reaches a matrix writer',
			write_activity: 'insertMatrixRowSequenceId',
			write_update_row: 'appendMatrixUpdateRow',
			write_history: 'recordTimeMachine',
			write_bulk_pair: 'recordBulkPair',
			write_bulk_birth: 'recordBulkBirth',
			write_cascade: 'recordBulkCascadeDelete',
			write_job: 'mediaJobs',
			write_counter_allocate: 'allocateComponentItemId',
			write_counter_absorb: 'absorbComponentItemIds',
			write_log_activity: 'logActivity',
		};
		for (const [action, fragment] of Object.entries(expectations)) {
			const offenders = writeDoorOffenders(closure, [declared(action)]);
			expect(offenders.length, `${action} must be an offender`).toBeGreaterThan(0);
			expect(offenders.join('\n'), action).toContain(fragment);
		}
	});

	test('a transitive writer is shown with its witness path down to the primitive', () => {
		const [offender] = writeDoorOffenders(closure, [declared('write_transitive')]);
		expect(offender).toContain('src/zz/engine.ts#zzSave');
		expect(offender).toContain(`${MATRIX_WRITE}#updateMatrixKeyData`);
	});

	test('an undeclared sibling is not judged — only the declared action is', () => {
		expect(writeDoorOffenders(closure, [declared('clean_inline')])).toEqual([]);
		// and the sibling really is a writer: the control is not vacuous
		expect(closure.members.has('tools/zz_ro/server/index.ts#tool.apiActions.sibling_writer')).toBe(
			true,
		);
	});

	test('an action the walk cannot see is itself an offender (an unanalysable claim is no claim)', () => {
		const offenders = writeDoorOffenders(closure, [declared('built_elsewhere')]);
		expect(offenders.length).toBe(1);
		expect(offenders[0]).toContain('not statically analysable');
	});
});

// ---------------------------------------------------------------------------
// Leg 1 — the declaration, checked by the loader
// ---------------------------------------------------------------------------

describe('LEG 1 — the loader checks the declaration (both ways)', () => {
	const handler = async () => ({ ok: true }) as never;
	const EXEMPT = { permission: null, gatedInHandler: 'UNGATED — a control', handler } as const;

	/** A module around one action; `background` lists it as backgroundRunnable. */
	function moduleWith(
		spec: Record<string, unknown>,
		background = false,
	): { tool: ToolServerModule } {
		return {
			tool: {
				name: 'tool_zz_ro',
				apiActions: { probe: spec as never },
				...(background ? { backgroundRunnable: ['probe'] } : {}),
			},
		};
	}
	const refusal = (spec: Record<string, unknown>, background = false): string | null => {
		try {
			validateToolModule(moduleWith(spec, background), 'tool_zz_ro');
			return null;
		} catch (error) {
			if (!isDedaloError(error)) throw error;
			expect(error.code).toBe('internal.invariant');
			return error.message;
		}
	};

	test('the accepted shapes', () => {
		expect(refusal({ ...EXEMPT, readOnly: true })).toBeNull();
		expect(refusal({ permission: 'tipo', minLevel: 1, readOnly: true, handler })).toBeNull();
		expect(refusal({ permission: 'record_tipo', minLevel: 1, readOnly: true, handler })).toBeNull();
		// 'developer' asserts a flag, not a level: the default level is never consulted
		expect(refusal({ permission: 'developer', readOnly: true, handler })).toBeNull();
		// absent is the mutating default, whatever the level
		expect(refusal({ permission: 'section', handler })).toBeNull();
	});

	test('only the literal true is a declaration', () => {
		for (const value of [false, 'true', 1, null, {}]) {
			expect(refusal({ ...EXEMPT, readOnly: value }), String(value)).toContain('readOnly');
		}
	});

	test('a background action cannot be read-only (a job is a write)', () => {
		expect(refusal({ ...EXEMPT, readOnly: true }, true)).toContain('backgroundRunnable');
	});

	test('a level-gated action must spell minLevel: 1 (the gated default is 2, write)', () => {
		expect(refusal({ permission: 'section', readOnly: true, handler })).toContain('minLevel: 1');
		expect(refusal({ permission: 'tipo', minLevel: 2, readOnly: true, handler })).toContain(
			'minLevel: 1',
		);
		expect(refusal({ permission: 'record', minLevel: 3, readOnly: true, handler })).toContain(
			'minLevel: 1',
		);
	});

	/**
	 * EXACTLY 1, not "at most 1". The gates ask `level < required`
	 * (tools/security.ts, security/write_door.ts): that is never true for 0, a
	 * negative or NaN, so such a spelling LOOKS like a declared read level and
	 * leaves the action with no level gate at all. Every level-reading kind is
	 * driven, because the rule is not per kind. (A string '1' is not a level either.)
	 */
	test('a level that is not exactly 1 is refused for every level-reading kind (0, negative, NaN, fraction, string)', () => {
		for (const permission of ['section', 'tipo', 'record', 'record_tipo', 'targets', 'sections']) {
			for (const minLevel of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY, '1', null]) {
				expect(
					refusal({ permission, minLevel, readOnly: true, handler }),
					`${permission} minLevel ${String(minLevel)}`,
				).toContain('minLevel: 1');
			}
			expect(refusal({ permission, minLevel: 1, readOnly: true, handler }), permission).toBeNull();
		}
		// a mutating (absent readOnly) action is not judged by this rule, whatever it spells
		expect(refusal({ permission: 'section', minLevel: 0, handler })).toBeNull();
		// the list of kinds that do NOT read a level is the closed one: a kind added
		// to the permission union later is level-gated until someone says otherwise
		expect(refusal({ permission: 'zz_future_kind', readOnly: true, handler })).toContain(
			'minLevel: 1',
		);
	});
});

// ---------------------------------------------------------------------------
// Leg 3 — the runtime scope
// ---------------------------------------------------------------------------

/**
 * The classified non-DML exports of a (comment-stripped) matrix_write.ts whose
 * body issues INSERT / UPDATE / DELETE. An UPDATE is `UPDATE <table> SET`: a
 * `FOR UPDATE` row lock on a SELECT (or the bare word `'UPDATE'` naming a lock
 * strength) is not a write.
 */
function nonDmlExportsThatWrite(source: string, classified: Record<string, string>): string[] {
	const dml =
		/\b(?:INSERT\s+INTO|DELETE\s+FROM)\b|\bUPDATE\s+(?:ONLY\s+)?(?:"[^"]+"|\$\{[^}]*\}|[A-Za-z_][\w.]*)\s+SET\b/;
	return topLevelBlocks(source)
		.filter(
			(block) => block.exported && classified[block.name] !== undefined && dml.test(block.body),
		)
		.map((block) => block.name)
		.sort();
}

/** Run `call` inside the read-only scope; the thrown value (sync or async), or null. */
async function refusalInsideScope(call: () => unknown): Promise<unknown> {
	try {
		await runReadOnly(() => call());
		return null;
	} catch (error) {
		return error;
	}
}

/** Every refusal must be the guard's own: internal.invariant, naming the door. */
function expectReadOnlyRefusal(refusal: unknown, door: string): void {
	expect(isDedaloError(refusal), `${door}: nothing refused it inside the scope`).toBe(true);
	if (!isDedaloError(refusal)) return;
	expect(refusal.code, door).toBe('internal.invariant');
	expect(refusal.message, `${door}: the guard must be the FIRST statement`).toContain(
		'declared readOnly reached a write door',
	);
	expect(refusal.message, door).toContain(door);
}

describe('LEG 3 — the scope and its doors', () => {
	test('the scope: in force inside runReadOnly (across awaits), absent outside it', async () => {
		expect(inReadOnlyScope()).toBe(false);
		expect(() => assertNotReadOnlyRequest('probe')).not.toThrow();
		await runReadOnly(async () => {
			expect(inReadOnlyScope()).toBe(true);
			// it follows the async tree, so a fire-and-forget write started here is refused too
			await Promise.resolve();
			await new Promise((resolve) => setTimeout(resolve, 1));
			expect(inReadOnlyScope()).toBe(true);
			expect(() => assertNotReadOnlyRequest('probe')).toThrow();
		});
		expect(inReadOnlyScope()).toBe(false);
	});

	/**
	 * THE SCOPE HAS NO EXIT (the module header states it, so it is gated). A scope
	 * that code can step out of — `exit`, `enterWith`, `disable` on the store — is a
	 * write door of its own, invisible to the static walk and to the guards. The
	 * module is the only place that can reach its private store, so the gate is on
	 * its own source and its export surface.
	 */
	const STORE_ESCAPES = /\breadOnlyStore\s*\.\s*(?:exit|enterWith|disable)\b/;

	test('the scope has NO exit: three exports, and the store is never exited, entered or disabled', () => {
		expect(Object.keys(readOnlyScope).sort()).toEqual([
			'assertNotReadOnlyRequest',
			'inReadOnlyScope',
			'runReadOnly',
		]);
		const source = stripComments(
			readFileSync(join(REPO_ROOT, 'src/core/security/read_only_scope.ts'), 'utf8'),
		);
		expect(STORE_ESCAPES.test(source)).toBe(false);
		// positive control: the detector sees each way out
		for (const way of [
			'return readOnlyStore.exit(fn);',
			'readOnlyStore.enterWith(false);',
			'readOnlyStore . disable();',
		]) {
			expect(STORE_ESCAPES.test(way), way).toBe(true);
		}
	});

	test('concurrent scopes do not bleed: a request outside one is never refused by it', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const inside = runReadOnly(async () => {
			await held;
			return inReadOnlyScope();
		});
		// while the read-only request is parked, an ordinary one writes freely
		expect(inReadOnlyScope()).toBe(false);
		expect(() => assertNotReadOnlyRequest('probe')).not.toThrow();
		release();
		expect(await inside).toBe(true);
	});

	/**
	 * THE GUARDED SET IS DERIVED. RAW_PRIMITIVES is every runtime export of
	 * matrix_write.ts that is not classified non-DML, so a new DML primitive is in
	 * this loop the day it is written — and red until it calls the guard.
	 *
	 * The non-DML classification (matrix_writer_closure.ts) answers a DIFFERENT
	 * question — "is this a curated component VALUE write" — so it cannot be the
	 * only source here: the two item-id counter functions are real UPDATEs of
	 * `meta` and were classified non-DML. CLASSIFIED_WRITERS names every non-DML
	 * export that still issues DML, and the derivation test below keeps the list
	 * equal to what the source actually does.
	 */
	const CLASSIFIED_WRITERS = [
		'insertMatrixRowSequenceId',
		'appendMatrixUpdateRow',
		'allocateComponentItemId',
		'absorbComponentItemIds',
	] as const;

	test('the derived primitive list is populous, and the classified writers are still classified', () => {
		expect(RAW_PRIMITIVES.length).toBeGreaterThanOrEqual(9);
		for (const name of CLASSIFIED_WRITERS) {
			expect(
				MATRIX_WRITE_NON_DML[name],
				`${name} is no longer a classified non-DML export`,
			).toBeDefined();
		}
	});

	test('every non-DML export whose body carries DML is a CLASSIFIED writer, and nothing else is', () => {
		const source = stripComments(readFileSync(join(REPO_ROOT, MATRIX_WRITE), 'utf8'));
		const writing = nonDmlExportsThatWrite(source, MATRIX_WRITE_NON_DML);
		expect(
			writing,
			'a MATRIX_WRITE_NON_DML export issues INSERT / UPDATE / DELETE: it is a write door for the read-only scope — guard it with assertNotReadOnlyRequest, add it to CLASSIFIED_WRITERS and to EXTRA_WRITE_DOORS',
		).toEqual([...CLASSIFIED_WRITERS].sort());
	});

	test('the derivation finds a writer hiding in the non-DML list, and spares a locked read (positive control)', () => {
		const control = [
			'export async function zzCounter(): Promise<void> {',
			'\tawait sql.unsafe(`UPDATE "${t}" SET meta = $1`);',
			'}',
			'export async function zzLockedRead(): Promise<void> {',
			'\tawait sql.unsafe(`SELECT x FROM t',
			'\t\t FOR UPDATE`);',
			'}',
			'export async function zzDelete(): Promise<void> {',
			'\tawait sql.unsafe(`DELETE FROM t`);',
			'}',
			'export async function zzInsert(): Promise<void> {',
			'\tawait sql.unsafe(`INSERT INTO t (a) VALUES (1)`);',
			'}',
			'export async function zzPrimitive(): Promise<void> {',
			'\tawait sql.unsafe(`UPDATE t SET a = 1`);',
			'}',
			'export function zzPure(): string {',
			"\treturn 'x';",
			'}',
		].join('\n');
		const classified = {
			zzCounter: 'r',
			zzLockedRead: 'r',
			zzDelete: 'r',
			zzInsert: 'r',
			zzPure: 'r',
		};
		// zzPrimitive is not classified non-DML (it IS a primitive): not this list's business
		expect(nonDmlExportsThatWrite(control, classified)).toEqual([
			'zzCounter',
			'zzDelete',
			'zzInsert',
		]);
	});

	test('EVERY matrix_write.ts DML primitive and classified writer refuses inside the scope', async () => {
		const doors = [...RAW_PRIMITIVES, ...CLASSIFIED_WRITERS];
		const exported = matrixWrite as unknown as Record<string, (...args: unknown[]) => unknown>;
		for (const name of doors) {
			const door = exported[name];
			expect(typeof door, `${name} is not exported by matrix_write.ts`).toBe('function');
			// garbage arguments: only a guard that runs FIRST can answer with the scope's refusal
			expectReadOnlyRefusal(await refusalInsideScope(() => (door as () => unknown)()), name);
		}
	});

	test('the Time Machine writers refuse inside the scope', async () => {
		expectReadOnlyRefusal(
			await refusalInsideScope(() =>
				timeMachine.recordTimeMachine(
					{
						sectionTipo: 'test3',
						sectionId: 1,
						componentTipo: 'test52',
						lang: 'lg-nolan',
						userId: -1,
						data: [],
					} as never,
					'2026-01-01 00:00:00',
				),
			),
			'recordTimeMachine',
		);
		const bulk = { sectionTipo: 'test3', sectionId: 1, userId: -1, bulkId: 1 };
		// the bulk writers' one INSERT is insertUndoRow; recordBulkPair reaches it too
		// (inside a transaction, which needs the database — so it is covered by the
		// structural pin below rather than called here)
		expectReadOnlyRefusal(
			await refusalInsideScope(() => timeMachine.recordBulkBirth({ ...bulk, image: undefined })),
			'insertUndoRow',
		);
		expectReadOnlyRefusal(
			await refusalInsideScope(() =>
				timeMachine.recordBulkCascadeDelete({ ...bulk, snapshot: undefined } as never),
			),
			'insertUndoRow',
		);
	});

	test('time_machine.ts has exactly two INSERT sites, both in guarded doors', () => {
		const source = stripComments(
			readFileSync(join(REPO_ROOT, 'src/core/db/time_machine.ts'), 'utf8'),
		);
		const inserting = topLevelBlocks(source)
			.filter((block) => /INSERT\s+INTO\s+matrix_time_machine/.test(block.body))
			.map((block) => block.name)
			.sort();
		expect(
			inserting,
			'a new matrix_time_machine INSERT site must call assertNotReadOnlyRequest first and be added to this list',
		).toEqual(['insertUndoRow', 'recordTimeMachine']);
	});

	test('the job manager refuses a submit inside the scope', async () => {
		expectReadOnlyRefusal(
			await refusalInsideScope(() =>
				mediaJobs.submit('zz_read_only_probe', (async () => undefined) as JobWorker, {
					lane: 'media',
				}),
			),
			'MediaJobManager.submit',
		);
	});

	/**
	 * A JOB NEVER INHERITS THE SCOPE — and there is no hatch to make it so. The
	 * situation: a read-only handler frees the only lane slot a QUEUED job is
	 * waiting for. The job's worker must not run inside that handler's scope
	 * (its own writes would be refused). It does not: `submit` refuses inside the
	 * scope, so every job was submitted outside it, and the queued job resumes
	 * from the `await` it parked at — in the context captured there. Driven
	 * through the real manager: a job holds the only slot, a second waits, and the
	 * first is STOPPED from inside `runReadOnly`.
	 */
	async function until(label: string, done: () => boolean): Promise<void> {
		const deadline = Date.now() + 2000;
		while (!done()) {
			if (Date.now() > deadline) throw new Error(`${label}: not reached within 2 s`);
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
	}

	/** Park one job on the only slot, queue a second behind it, free the slot FROM INSIDE the scope. */
	async function freeSlotInsideScope(manager: MediaJobManager): Promise<{
		firstScope: boolean | undefined;
		secondScope: boolean | undefined;
		status: string;
	}> {
		const seen: { first?: boolean; second?: boolean } = {};
		const first = manager.submit(
			'zz_ro_holder',
			(async (ctx) => {
				seen.first = inReadOnlyScope();
				await new Promise<void>((resolve) =>
					ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
				);
			}) as JobWorker,
			{ lane: 'media' },
		);
		const second = manager.submit(
			'zz_ro_queued',
			(async () => {
				seen.second = inReadOnlyScope();
				return 'ran';
			}) as JobWorker,
			{ lane: 'media' },
		);
		await until('the holder runs', () => manager.status(first.id)?.status === 'running');
		// the second is parked in the lane queue: not started, so it has seen nothing yet
		expect(manager.status(second.id)?.status).toBe('queued');
		expect(seen.second).toBeUndefined();
		await runReadOnly(async () => {
			expect(inReadOnlyScope(), 'the stop below must run inside the scope').toBe(true);
			expect(manager.stop(first.id)).toBe(true);
			await until(
				'the queued job ends',
				() => !['queued', 'running'].includes(manager.status(second.id)?.status ?? 'queued'),
			);
		});
		return {
			firstScope: seen.first,
			secondScope: seen.second,
			status: manager.status(second.id)?.status ?? 'missing',
		};
	}

	test('a job queued behind a slot that a read-only handler frees does NOT inherit the scope', async () => {
		const outcome = await freeSlotInsideScope(new MediaJobManager({ budgets: { media: 1 } }));
		// both workers ran, outside the scope: no escape hatch is needed
		expect(outcome.status).toBe('done');
		expect(outcome.firstScope).toBe(false);
		expect(outcome.secondScope, 'the queued job must not run inside the freeing call’s scope').toBe(
			false,
		);
	});

	test('positive control: a manager that DID start workers inside the freeing call’s scope would be seen', async () => {
		// models the refactor this test guards against: a scheduler that runs the next
		// worker from the context of whichever call frees the slot
		class LeakyManager extends MediaJobManager {
			protected override runWorker(...args: Parameters<MediaJobManager['runWorker']>) {
				return runReadOnly(() => super.runWorker(...args));
			}
		}
		const outcome = await freeSlotInsideScope(new LeakyManager({ budgets: { media: 1 } }));
		expect(outcome.secondScope).toBe(true);
	});

	/**
	 * THE ACTIVITY DOOR REFUSES, BUT ITS EMITTER SWALLOWS. `logActivity` is the
	 * only production writer of an activity row and never throws by design (an
	 * audit write must never fail the user action). Inside the scope that means:
	 * the call RESOLVES, no row is written (the guard is the first statement of
	 * `insertMatrixRowSequenceId`, proven above to run before any SQL), and the
	 * refusal is a logged line. A read-only action that logs activity is therefore
	 * NOT failed loudly at runtime — the static walk (leg 2) is what names it. This
	 * pins the outcome so no statement of the claim can drift back to "fails loudly".
	 */
	test('logActivity inside the scope resolves, drops the row and logs the guard’s refusal', async () => {
		const logged = spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			const outcome = await runReadOnly(() =>
				logActivity({ what: 'SAVE', tipo: 'test52', userId: -1, host: 'localhost', data: {} }),
			);
			expect(outcome).toBeUndefined();
			expect(logged).toHaveBeenCalledTimes(1);
			const [line, refusal] = logged.mock.calls[0] as [unknown, unknown];
			expect(line).toContain('activity log write failed (swallowed)');
			expectReadOnlyRefusal(refusal, 'insertMatrixRowSequenceId');
		} finally {
			logged.mockRestore();
		}
	});
});
