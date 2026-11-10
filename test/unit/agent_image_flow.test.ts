/**
 * E2E eval: the flagship flow — "analyze this image, extract the people, fill
 * them into the correct ontology nodes and relations" — end to end, OFFLINE.
 *
 * A scripted provider stands in for the vision model: it plays the trajectory
 * a real agent would (discover → propose a find-or-create + set-field plan),
 * so the assertion is the HARNESS, not the model. The plan is then confirmed
 * and applied on the SCRATCH section (test65 → matrix_test), and we read the
 * data back through the same registry read tool an external client would use.
 *
 * This is the always-on twin; a live vision run against the real Anthropic
 * provider is gated behind an API key and is exercised manually (rewrite/ai/mcp.md
 * Inspector/smoke section).
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules): the
// scratch section moves to `test65`, whose OWN component_input_text
// (`test159`) replaces the install text component the plan used to name — the
// pair is coherent (a component of its own section) and exists on every
// install. Two constraints picked it: NOT `test3`, which carries a
// component_external (`test215`, zenon) that turns an edit read into an
// OUTBOUND request; and `test159` is is_translatable, so the find-or-create
// round trip keeps the lg-eng the match asks for (a non-translatable component
// normalizes to lg-nolan and the idempotency probe would never re-find it).
// 2026-11-10 (T0-2 / D4): moved from test183 to test65 — find_or_create now
// asks the New-button predicate (section ≥ 2 AND its button_new ≥ 2), and test183
// has no button_new (no create at all, the superuser included); test65 carries
// test13.
// Still matrix_test, still swept in afterAll.

import { afterAll, describe, expect, test } from 'bun:test';
import {
	applyChangePlan,
	type ChangePlan,
	validateChangePlan,
} from '../../src/ai/agent/change_plan.ts';
import type {
	AgentAssistantTurn,
	AgentLlmProvider,
	AgentTranscriptEntry,
} from '../../src/ai/agent/llm_provider.ts';
import { runAgent } from '../../src/ai/agent/loop.ts';
import { readSectionRecord } from '../../src/ai/mcp/tools/records_read.ts';
import { sql } from '../../src/core/db/postgres.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { cleanScratchRecord } from '../helpers/test_data.ts';

const SUPERUSER: Principal = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

const SECTION = 'test65';
const TABLE = 'matrix_test';
const NAME_FIELD = 'test159'; // stands in for a "name" text component

const createdIds: number[] = [];

afterAll(async () => {
	for (const id of createdIds) {
		await cleanScratchRecord(SECTION, id, TABLE);
	}
});

/** A tiny valid 1x1 PNG (base64) — the "document photo" the agent analyzes. */
const ONE_PX_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** The extracted person the scripted vision pass "reads" off the image. */
const PERSON_NAME = `Ada Lovelace ${process.pid}-${Math.floor(Math.random() * 1e9)}`;

/**
 * Scripted trajectory: discover the section, then propose a plan that
 * find-or-creates the person and sets a second field via {ref} chaining —
 * exactly the shape the write-mode system prompt asks for.
 */
function visionScript(): AgentAssistantTurn[] {
	const plan: ChangePlan = {
		plan_version: 1,
		summary: `Record the person '${PERSON_NAME}' extracted from the image.`,
		ops: [
			{
				op_id: 'person',
				tool: 'dedalo_find_or_create',
				args: {
					section_tipo: SECTION,
					match: [{ field: NAME_FIELD, value: PERSON_NAME, lang: 'lg-eng' }],
				},
				summary: `Find or create the person '${PERSON_NAME}'`,
			},
			{
				op_id: 'note',
				tool: 'dedalo_set_field',
				args: {
					section_tipo: SECTION,
					section_id: { ref: 'person' },
					field: NAME_FIELD,
					value: 'extracted-from-image',
					lang: 'lg-spa',
				},
				summary: 'Annotate the record with the extraction provenance',
			},
		],
	};
	return [
		{
			text: 'I found one person in the image and prepared a plan.',
			tool_uses: [
				{
					id: 'tu_plan',
					name: 'propose_change_plan',
					input: plan as unknown as Record<string, unknown>,
				},
			],
			stop_reason: 'tool_use',
		},
	];
}

class ScriptedProvider implements AgentLlmProvider {
	readonly name = 'scripted';
	readonly seen: AgentTranscriptEntry[][] = [];
	private index = 0;
	constructor(private readonly script: AgentAssistantTurn[]) {}
	async createTurn(request: { transcript: AgentTranscriptEntry[] }): Promise<AgentAssistantTurn> {
		this.seen.push([...request.transcript]);
		const turn = this.script[Math.min(this.index, this.script.length - 1)];
		this.index++;
		return turn as AgentAssistantTurn;
	}
}

describe('image → people → ontology (offline E2E)', () => {
	test('the agent proposes a plan from an image; confirm+apply writes the record', async () => {
		const provider = new ScriptedProvider(visionScript());

		// 1) The image reaches the loop and the agent proposes (never writes).
		const run = await runAgent(
			SUPERUSER,
			{
				text: 'Analyze this image and record the people you find.',
				images: [{ media_type: 'image/png', data_base64: ONE_PX_PNG }],
			},
			provider,
			{ mode: 'write' },
		);
		expect(run.stop).toBe('change_plan');
		expect(run.change_plan).toBeDefined();
		// The image really was in the request the provider saw.
		const firstEntry = run.transcript[0] as { images?: unknown[] };
		expect(firstEntry.images?.length).toBe(1);

		// Nothing written yet.
		const before = (await sql`
			SELECT count(*)::int AS n FROM matrix_test
			WHERE section_tipo = ${SECTION}
			  AND EXISTS (
				SELECT 1 FROM jsonb_array_elements(string->'test159') e
				WHERE e->>'value' = ${PERSON_NAME}
			)
		`) as { n: number }[];
		expect(Number(before[0]?.n)).toBe(0);

		// 2) Human confirms → apply the exact validated plan.
		const plan = run.change_plan as NonNullable<typeof run.change_plan>;
		const report = await applyChangePlan(SUPERUSER, plan, plan.plan_hash, { allowWrite: true });
		expect(report.failed).toBeUndefined();
		const personId = report.created.person as number;
		expect(personId).toBeGreaterThan(0);
		createdIds.push(personId);

		// 3) The person's name and the provenance annotation both landed on the
		//    SAME record (the {ref} resolved) — read the persisted truth back.
		const items =
			(
				(await sql.unsafe(
					`SELECT string->'${NAME_FIELD}' AS items FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
					[SECTION, personId],
				)) as { items: { value?: string; lang?: string }[] | null }[]
			)[0]?.items ?? [];
		const values = items.map((item) => item.value);
		expect(values).toContain(PERSON_NAME);
		expect(values).toContain('extracted-from-image');

		// And the record is genuinely reachable through the registry read tool
		// (the envelope the client renders resolves exactly this one record).
		const read = await readSectionRecord(SUPERUSER, {
			section_tipo: SECTION,
			section_id: personId,
			mode: 'edit',
		});
		const envelope = read.data.find((entry) => (entry as { typo?: string }).typo === 'sections') as
			| { entries?: { section_id: number }[] }
			| undefined;
		expect(envelope?.entries?.[0]?.section_id).toBe(personId);
	});

	test('re-running the same plan is idempotent (find, not duplicate)', async () => {
		const plan = {
			plan_version: 1 as const,
			summary: 'idempotency probe',
			ops: [
				{
					op_id: 'person',
					tool: 'dedalo_find_or_create',
					args: {
						section_tipo: SECTION,
						match: [{ field: NAME_FIELD, value: PERSON_NAME, lang: 'lg-eng' }],
					},
					summary: 'find the same person',
				},
			],
		};
		const validated = await validateChangePlan(SUPERUSER, plan, { allowWrite: true });
		const report = await applyChangePlan(SUPERUSER, validated, validated.plan_hash, {
			allowWrite: true,
		});
		// find_or_create found the existing record (created:false) — no new row.
		const foundId = (report.applied[0]?.result as { section_id: number }).section_id;
		expect(createdIds).toContain(foundId);
		const rows = (await sql`
			SELECT count(*)::int AS n FROM matrix_test
			WHERE section_tipo = ${SECTION}
			  AND EXISTS (
				SELECT 1 FROM jsonb_array_elements(string->'test159') e
				WHERE e->>'value' = ${PERSON_NAME}
			)
		`) as { n: number }[];
		expect(Number(rows[0]?.n)).toBe(1);
	});
});
