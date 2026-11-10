/**
 * Gate: the agent write harness — images through the provider seam and the
 * propose→confirm→apply change-plan protocol (Phase 4 of the work-system MCP
 * foundation). Fully OFFLINE via the scripted provider; DB writes only on the
 * scratch section (test65 → matrix_test) and removed afterwards.
 *
 * The load-bearing assertions:
 *   - a valid proposal ENDS the turn with a validated plan and ZERO writes;
 *   - an invalid proposal returns to the model as is_error (loop continues);
 *   - the hash pins what the human confirmed (mutation ⇒ plan_hash_mismatch);
 *   - apply executes ops sequentially THROUGH the registry handlers with
 *     {ref} chaining, and reports partial failure precisely;
 *   - image entries map to Messages-API image blocks (pure toMessages).
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules). Two
// bindings went:
//   - the write surface is `test65` + its OWN component_input_text `test159`
//     (a coherent section/component pair, matrix_test, present on every
//     install). NOT `test3`, whose component_external `test215` would turn an
//     edit read into an outbound request; `test159` is is_translatable, so the
//     lg-* a plan asks for survives the round trip. (2026-11-10, T0-2 / D4: the
//     surface moved from test183 to test65 — find_or_create now asks the create
//     predicate, and test183 has no button_new, so it admits no create at all,
//     the superuser included; test65 carries test13.)
//   - the out-of-scope half no longer reads whatever install records the
//     database happens to hold (`expect(hiddenId).toBeGreaterThan(0)` was the
//     file's one red on the suite DB). It BUILDS the split: the synthetic ACL
//     identities (test/helpers/acl_identity_fixture.ts) plus one scratch
//     `test3` record carrying a project the non-admin does NOT hold — test3 is
//     project-gated for real through its component_filter `test101`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { toMessages } from '../../src/ai/agent/anthropic_provider.ts';
import {
	applyChangePlan,
	hashChangePlan,
	validateChangePlan,
} from '../../src/ai/agent/change_plan.ts';
import type {
	AgentAssistantTurn,
	AgentLlmProvider,
	AgentTranscriptEntry,
} from '../../src/ai/agent/llm_provider.ts';
import { runAgent } from '../../src/ai/agent/loop.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/dedalo_error.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { principalCanAccessRecord } from '../../src/core/security/record_scope.ts';
import {
	ACL_NON_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';
import { cleanScratchRecord, createScratchRecord } from '../helpers/test_data.ts';

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };
/**
 * Non-admin scoped principal (the only kind write surfaces accept) — the
 * SYNTHETIC identity, which really exists and really holds exactly one project.
 */
const SCOPED: Principal = {
	userId: ACL_NON_ADMIN_USER_ID,
	isGlobalAdmin: false,
	isDeveloper: false,
};

const SCRATCH_SECTION = 'test65';
const SCRATCH_TABLE = 'matrix_test';
const TEXT_FIELD = 'test159';

/** The project-gated section of the out-of-scope half, and what gates it. */
const GATED_SECTION = 'test3';
const GATED_FILTER = 'test101'; // test3's component_filter — buildProjectsFilter keys on it
const GATED_TEXT = 'test52'; // test3's own component_input_text
/** The scratch record the scoped principal must NOT be able to name (≥900000). */
const HIDDEN_ID = 941101;
/** A project the scoped principal does NOT hold — what makes HIDDEN_ID hidden. */
const OTHER_PROJECT_ID = 1;
const PROJECTS_SECTION = 'dd153';
const PROJECT_LOCATOR_TYPE = 'dd675';

const createdIds: number[] = [];

beforeAll(async () => {
	await installAclIdentityFixture();
	await createScratchRecord(GATED_SECTION, HIDDEN_ID, {
		relation: {
			[GATED_FILTER]: [
				{
					id: 1,
					type: PROJECT_LOCATOR_TYPE,
					section_id: String(OTHER_PROJECT_ID),
					section_tipo: PROJECTS_SECTION,
					from_component_tipo: GATED_FILTER,
				},
			],
		},
		string: { [GATED_TEXT]: [{ id: 1, lang: 'lg-eng', value: 'out-of-scope scratch' }] },
	});
});

afterAll(async () => {
	for (const id of createdIds) {
		await cleanScratchRecord(SCRATCH_SECTION, id, SCRATCH_TABLE);
	}
	await cleanScratchRecord(GATED_SECTION, HIDDEN_ID);
	await removeAclIdentityFixture();
});

class ScriptedProvider implements AgentLlmProvider {
	readonly name = 'scripted';
	readonly seenTranscripts: AgentTranscriptEntry[][] = [];
	private turnIndex = 0;
	constructor(private readonly script: AgentAssistantTurn[]) {}
	async createTurn(request: { transcript: AgentTranscriptEntry[] }): Promise<AgentAssistantTurn> {
		this.seenTranscripts.push([...request.transcript]);
		const turn = this.script[Math.min(this.turnIndex, this.script.length - 1)];
		this.turnIndex++;
		return turn as AgentAssistantTurn;
	}
}

function planFixture(unique: string) {
	return {
		plan_version: 1 as const,
		summary: `Create a scratch record holding '${unique}'.`,
		ops: [
			{
				op_id: 'op1',
				tool: 'dedalo_find_or_create',
				args: {
					section_tipo: SCRATCH_SECTION,
					match: [{ field: TEXT_FIELD, value: unique, lang: 'lg-spa' }],
				},
				summary: `Find-or-create the '${unique}' record`,
			},
			{
				op_id: 'op2',
				tool: 'dedalo_set_field',
				args: {
					section_tipo: SCRATCH_SECTION,
					section_id: { ref: 'op1' },
					field: TEXT_FIELD,
					value: `${unique}-second`,
					lang: 'lg-eng',
				},
				summary: 'Add the English value onto the created record',
			},
		],
	};
}

describe('images through the provider seam (pure)', () => {
	test('a user entry with images maps to image blocks BEFORE the text', () => {
		const messages = toMessages([
			{
				role: 'user',
				text: 'What does this photo show?',
				images: [
					{ media_type: 'image/jpeg', data_base64: 'aGVsbG8=' },
					{ url: 'https://example.org/pic.png' },
				],
			},
		]);
		const content = messages[0]?.content as {
			type: string;
			source?: { type: string; media_type?: string; url?: string };
			text?: string;
		}[];
		expect(content.length).toBe(3);
		expect(content[0]?.type).toBe('image');
		expect(content[0]?.source?.type).toBe('base64');
		expect(content[0]?.source?.media_type).toBe('image/jpeg');
		expect(content[1]?.source?.type).toBe('url');
		expect(content[1]?.source?.url).toBe('https://example.org/pic.png');
		expect(content[2]?.type).toBe('text');
	});

	test('image entries reach the provider request untouched (scripted loop)', async () => {
		const provider = new ScriptedProvider([
			{ text: 'seen', tool_uses: [], stop_reason: 'end_turn' },
		]);
		await runAgent(
			SUPERUSER,
			{ text: 'analyze', images: [{ media_type: 'image/png', data_base64: 'eA==' }] },
			provider,
		);
		const first = provider.seenTranscripts[0]?.[0] as { images?: unknown[] };
		expect(first.images?.length).toBe(1);
	});
});

describe('propose_change_plan (scripted loop, write mode)', () => {
	test('a valid proposal ends the turn with a validated plan and ZERO writes', async () => {
		const unique = `mcp-plan-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
		const provider = new ScriptedProvider([
			{
				text: 'Proposing the plan.',
				tool_uses: [{ id: 'tu1', name: 'propose_change_plan', input: planFixture(unique) }],
				stop_reason: 'tool_use',
			},
		]);
		const run = await runAgent(SUPERUSER, 'file this', provider, { mode: 'write' });
		expect(run.stop).toBe('change_plan');
		expect(run.change_plan).toBeDefined();
		expect(run.change_plan?.plan_hash).toMatch(/^[0-9a-f]{64}$/);
		expect(run.change_plan?.ops.length).toBe(2);

		// NOTHING was written: the unique value exists nowhere.
		const rows = (await sql`
			SELECT section_id FROM matrix_test
			WHERE section_tipo = ${SCRATCH_SECTION}
			  AND EXISTS (
				SELECT 1 FROM jsonb_array_elements(string->'test159') e
				WHERE e->>'value' LIKE ${`${unique}%`}
			)
		`) as { section_id: number }[];
		expect(rows.length).toBe(0);
	});

	test('write tools stay UNEXECUTABLE inside the loop, even in write mode', async () => {
		const provider = new ScriptedProvider([
			{
				text: '',
				tool_uses: [
					{
						id: 'tu1',
						name: 'dedalo_create_record',
						input: { section_tipo: SCRATCH_SECTION },
					},
				],
				stop_reason: 'tool_use',
			},
			{ text: 'done', tool_uses: [], stop_reason: 'end_turn' },
		]);
		const run = await runAgent(SUPERUSER, 'create it', provider, { mode: 'write' });
		expect(run.stop).toBe('end_turn');
		const results = provider.seenTranscripts[1]?.find((entry) => entry.role === 'tool_results') as {
			results: { is_error: boolean; content: string }[];
		};
		expect(results.results[0]?.is_error).toBe(true);
		expect(results.results[0]?.content).toContain('Unknown tool');
	});

	test('an invalid proposal returns as is_error and the loop continues', async () => {
		const badPlan = {
			plan_version: 1,
			summary: 'bad',
			ops: [
				{
					op_id: 'op1',
					tool: 'dedalo_read_record', // not a write tool
					args: { section_tipo: SCRATCH_SECTION },
					summary: 'nope',
				},
			],
		};
		const provider = new ScriptedProvider([
			{
				text: '',
				tool_uses: [{ id: 'tu1', name: 'propose_change_plan', input: badPlan }],
				stop_reason: 'tool_use',
			},
			{ text: 'repaired answer', tool_uses: [], stop_reason: 'end_turn' },
		]);
		const run = await runAgent(SUPERUSER, 'file this', provider, { mode: 'write' });
		expect(run.stop).toBe('end_turn');
		expect(run.change_plan).toBeUndefined();
		const results = provider.seenTranscripts[1]?.find((entry) => entry.role === 'tool_results') as {
			results: { is_error: boolean; content: string }[];
		};
		expect(results.results[0]?.is_error).toBe(true);
		expect(results.results[0]?.content).toContain('not a write tool');
	});
});

describe('validate + hash + apply (live scratch writes)', () => {
	test('hash pins the confirmed plan; mutation ⇒ plan_hash_mismatch', async () => {
		const unique = `mcp-hash-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
		const plan = planFixture(unique);
		const validated = await validateChangePlan(SUPERUSER, plan, { allowWrite: true });
		const mutated = structuredClone(validated);
		(mutated.ops[1] as unknown as { args: { value: string } }).args.value = 'evil';
		await expect(
			applyChangePlan(SUPERUSER, mutated, validated.plan_hash, { allowWrite: true }),
		).rejects.toMatchObject({ code: 'mcp.plan_hash_mismatch' });
	});

	test('apply chains {ref} through the registry handlers; report is precise', async () => {
		const unique = `mcp-apply-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
		const validated = await validateChangePlan(SUPERUSER, planFixture(unique), {
			allowWrite: true,
		});
		const report = await applyChangePlan(SUPERUSER, validated, validated.plan_hash, {
			allowWrite: true,
		});
		expect(report.failed).toBeUndefined();
		expect(report.applied.map((entry) => entry.op_id)).toEqual(['op1', 'op2']);
		const createdId = report.created.op1 as number;
		expect(createdId).toBeGreaterThan(0);
		createdIds.push(createdId);

		// Both values landed on the SAME record (the ref resolved).
		const rows = (await sql.unsafe(
			`SELECT string->'${TEXT_FIELD}' AS items FROM ${SCRATCH_TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[SCRATCH_SECTION, createdId],
		)) as { items: { value?: string }[] | null }[];
		const values = (rows[0]?.items ?? []).map((item) => item.value);
		expect(values).toContain(unique);
		expect(values).toContain(`${unique}-second`);
	});

	test('partial failure: first op applies, the bad op fails, the rest skip', async () => {
		const unique = `mcp-partial-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
		const plan = {
			plan_version: 1 as const,
			summary: 'partial failure fixture',
			ops: [
				{
					op_id: 'op1',
					tool: 'dedalo_find_or_create',
					args: {
						section_tipo: SCRATCH_SECTION,
						match: [{ field: TEXT_FIELD, value: unique, lang: 'lg-spa' }],
					},
					summary: 'create',
				},
				{
					op_id: 'op2',
					tool: 'dedalo_set_field',
					args: {
						section_tipo: SCRATCH_SECTION,
						section_id: { ref: 'op1' },
						field: TEXT_FIELD,
						// no value → the tool refuses with invalid_request
					},
					summary: 'broken set',
				},
				{
					op_id: 'op3',
					tool: 'dedalo_set_field',
					args: {
						section_tipo: SCRATCH_SECTION,
						section_id: { ref: 'op1' },
						field: TEXT_FIELD,
						value: 'never-runs',
						lang: 'lg-eng',
					},
					summary: 'never runs',
				},
			],
		};
		const validated = await validateChangePlan(SUPERUSER, plan, { allowWrite: true });
		const report = await applyChangePlan(SUPERUSER, validated, validated.plan_hash, {
			allowWrite: true,
		});
		if (report.created.op1 !== undefined) createdIds.push(report.created.op1);
		expect(report.applied.map((entry) => entry.op_id)).toEqual(['op1']);
		expect(report.failed?.op_id).toBe('op2');
		expect(report.skipped).toEqual(['op3']);
	});

	test('validation walls: allowlist, permissions, forward refs, read-only surface', async () => {
		const base = planFixture(`mcp-walls-${process.pid}`);
		// Read-only surface refuses plans outright.
		await expect(validateChangePlan(SUPERUSER, base, {})).rejects.toMatchObject({
			code: 'mcp.write_disabled',
		});
		// Off-allowlist section.
		await expect(
			validateChangePlan(SUPERUSER, base, {
				allowWrite: true,
				writableSections: new Set([GATED_SECTION]),
			}),
		).rejects.toMatchObject({ code: 'perm.section_not_writable' });
		// A denied user fails the permission dry-run before anything else runs.
		await expect(
			validateChangePlan({ userId: 999999, isGlobalAdmin: false, isDeveloper: false }, base, {
				allowWrite: true,
			}),
		).rejects.toMatchObject({ code: 'perm.denied' });
		// Forward ref (op2 references op1 BEFORE it) is rejected.
		const forward = structuredClone(base);
		forward.ops.reverse();
		await expect(
			validateChangePlan(SUPERUSER, forward, { allowWrite: true }),
		).rejects.toMatchObject({ code: 'request.invalid' });
		// Field labels are STAMPED to tipos in the validated plan.
		const validated = await validateChangePlan(SUPERUSER, base, { allowWrite: true });
		expect((validated.ops[1] as unknown as { args: { field: string } }).args.field).toBe(
			TEXT_FIELD,
		);
		// And the hash is over the resolved plan.
		expect(validated.plan_hash).toBe(hashChangePlan(validated));
	});

	test('scoped user cannot smuggle an out-of-scope record into a plan', async () => {
		// The record EXISTS and carries a project the scoped principal does not
		// hold — built above, never borrowed from an install.
		const visible = await sql`
			SELECT section_id FROM matrix_test
			WHERE section_tipo = ${GATED_SECTION} AND section_id = ${HIDDEN_ID}
		`;
		expect((visible as { section_id: number }[]).length).toBe(1);
		// …and it is genuinely OUT of the principal's scope: the gate the plan
		// validator consults says no, so the wall below cannot be vacuous.
		expect(await principalCanAccessRecord(GATED_SECTION, HIDDEN_ID, SCOPED)).toBe(false);
		try {
			await validateChangePlan(
				SCOPED,
				{
					plan_version: 1,
					summary: 'smuggle',
					ops: [
						{
							op_id: 'op1',
							tool: 'dedalo_set_field',
							args: {
								section_tipo: GATED_SECTION,
								section_id: HIDDEN_ID,
								field: GATED_TEXT,
								value: 'x',
							},
							summary: 'smuggle',
						},
					],
				},
				{ allowWrite: true },
			);
			throw new Error('expected a wall');
		} catch (error) {
			expect(error).toBeInstanceOf(DedaloError);
			// Either the permission dry-run or the scope gate stops it — both walls
			// are correct; what matters is that it NEVER validates.
			expect(['perm.denied', 'perm.out_of_scope']).toContain((error as DedaloError).code);
		}
	});
});
