/**
 * TOOLS-4, THE GRANT HALF (closure Step 3; WC-2026-10-01-identify-vision-grant)
 * — a vision-model spend needs the caller's profile to authorize `tool_identify`.
 *
 * WHAT WAS WRONG (measured at 45b8c45162, src/core/api/handlers/dd_identify_api.ts):
 * `get_proposals` with `source: 'vision'` (or `'all'`) called the vision model
 * for ANY caller who could read the section, and `identify_by_image` shipped the
 * photograph to an EXTERNAL multimodal encoder for the same — the only switch
 * was the installation's. A model call is a resource with an owner; the tool
 * grant is its owner half (the per-user budget is the other half, and lands
 * with its ledger).
 *
 * THE IDENTITIES are authz_door_fixture's, asserted through the REAL resolver:
 * CONTROL (every test3 grant, no tool_identify) and TOOL_GRANTED (the same
 * grants, plus tool_identify) — the grant is the ONLY difference. No mock of the
 * grant: every leg below runs the production `requireToolGrant`
 * (`assertToolGranted` → `getUserTools`), and the REAL registered handler where
 * the door can be reached without a model.
 *
 * EACH REFUSAL HAS A SERVED TWIN, and the spend is COUNTED: a refused leg shows
 * zero vision / encoder calls, the granted twin shows the call happened.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { MultimodalEmbeddingProvider } from '../../src/ai/rag/multimodal_embedding_provider.ts';
import type { ApiRequestContext } from '../../src/core/api/handler_context.ts';
import {
	buildGetProposals,
	buildIdentifyByImage,
	defaultIdentifyByImageDeps,
	defaultIdentifyProposalsDeps,
	type IdentifyByImageDeps,
	type IdentifyProposalsDeps,
	identifyApiActions,
	VISION_SPEND_TOOL,
} from '../../src/core/api/handlers/dd_identify_api.ts';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { isDedaloError } from '../../src/core/errors/index.ts';
import type { Principal } from '../../src/core/security/permissions.ts';
import { getUserTools } from '../../src/core/tools/registry.ts';
import {
	AMPLE_AI_SPEND_LIMITS,
	setAiSpendLimits,
	sweepAiSpendLedger,
} from '../helpers/ai_spend_ledger.ts';
import {
	AUTHZ_PROJECT_P,
	AUTHZ_SECTION,
	type AuthzIdentities,
	assertAuthzDoorContrast,
	createDoorRecord,
	installAuthzDoorFixture,
	removeAuthzDoorFixture,
	resolveAuthzIdentities,
} from '../helpers/authz_door_fixture.ts';
import { DB_READY } from '../helpers/db_ready.ts';

/** A 1×1 PNG — the smallest thing the sniffer accepts as an image. */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
).toString('base64');

const ctx = (principal: Principal): ApiRequestContext =>
	({ requestId: 'zzvision-grant', clientIp: '127.0.0.1', principal }) as ApiRequestContext;

/** The handler's answer as one code: the thrown error's, or 'served'. */
async function codeOf(run: Promise<unknown>): Promise<string> {
	try {
		await run;
		return 'served';
	} catch (error) {
		if (isDedaloError(error)) return error.code;
		throw error;
	}
}

let ids: AuthzIdentities;
let seedId = 0;

describe.if(DB_READY)('TOOLS-4 grant half — the vision spend needs tool_identify', () => {
	beforeAll(async () => {
		await installAuthzDoorFixture();
		seedId = await createDoorRecord(AUTHZ_SECTION, AUTHZ_PROJECT_P);
		ids = await resolveAuthzIdentities();
		// The vision doors are METERED and an unset limit is 0: the granted twin
		// (the only identity that reaches the spend) gets ample limits on its own
		// user record, which the fixture's removal deletes. The budget is
		// ai_spend_budget_native's subject, not this gate's.
		await setAiSpendLimits({ userId: ids.toolGranted.userId }, AMPLE_AI_SPEND_LIMITS);
	});
	afterAll(async () => {
		if (ids !== undefined) await sweepAiSpendLedger([ids.toolGranted.userId]);
		await removeAuthzDoorFixture();
	});

	test.skip('the contrast is live: the SAME grants, tool_identify is the only difference — SKIPPED: tool_identify is withdrawn from the tool registry (WC-2026-10-29, provisional until its redesign)', async () => {
		await assertAuthzDoorContrast(ids);
		const toolsOf = async (principal: Principal) =>
			(await getUserTools(principal.userId)).some((tool) => tool.name === VISION_SPEND_TOOL);
		expect({
			control: await toolsOf(ids.control),
			granted: await toolsOf(ids.toolGranted),
		}).toEqual({ control: false, granted: true });
	});

	// ── get_proposals: the REAL registered handler ────────────────────────────
	const proposals = (source: string) =>
		({
			action: 'get_proposals',
			options: { section_tipo: AUTHZ_SECTION, section_id: seedId, source },
		}) as unknown as Rqo;

	test.skip('get_proposals (the registered door): vision ungranted → tool.not_authorized; granted and vote-only pass the grant — SKIPPED: tool_identify is withdrawn from the tool registry (WC-2026-10-29, provisional until its redesign)', async () => {
		const door = identifyApiActions.get_proposals;
		if (door === undefined) throw new Error('dd_identify_api.get_proposals is not registered');
		const answers = {
			visionUngranted: await codeOf(door(proposals('vision'), ctx(ids.control))),
			allUngranted: await codeOf(door(proposals('all'), ctx(ids.control))),
			visionGranted: await codeOf(door(proposals('vision'), ctx(ids.toolGranted))),
			voteUngranted: await codeOf(door(proposals('neighbour_vote'), ctx(ids.control))),
		};
		expect({
			visionUngranted: answers.visionUngranted,
			allUngranted: answers.allUngranted,
			visionGrantedPasses: answers.visionGranted !== 'tool.not_authorized',
			voteUngrantedPasses: answers.voteUngranted !== 'tool.not_authorized',
		}).toEqual({
			visionUngranted: 'tool.not_authorized',
			allUngranted: 'tool.not_authorized',
			visionGrantedPasses: true,
			voteUngrantedPasses: true,
		});
	});

	// THE ORDER IS PART OF THE PROMISE: refused BEFORE the profile is loaded, so
	// an ungranted caller cannot learn which sections carry an identification
	// profile (identify.no_profile vs tool.not_authorized). Both the model calls
	// and the PROFILE LOADS are counted.
	for (const source of ['vision', 'all'] as const) {
		test.skip(`get_proposals (${source}): a refused vision request loads NO profile and calls NO model; the granted twin does both — SKIPPED: tool_identify is withdrawn from the tool registry (WC-2026-10-29, provisional until its redesign)`, async () => {
			const calls = { profile: 0, vision: 0 };
			const deps: IdentifyProposalsDeps = {
				...defaultIdentifyProposalsDeps(),
				loadProfile: async () => {
					calls.profile++;
					return {
						id: 'zzvision',
						label: 'zzvision',
						criteria: [],
						previewComponent: null,
					} as never;
				},
				runVision: async () => {
					calls.vision++;
					return { declined: { reason: 'no_model' }, proposals: [], model: null } as never;
				},
				runNeighbourVote: async () => ({ proposals: [], skipped: [] }) as never,
			};
			const handler = buildGetProposals(deps);
			const refusedCode = await codeOf(handler(proposals(source), ctx(ids.control)));
			const refused = { ...calls };
			await codeOf(handler(proposals(source), ctx(ids.toolGranted)));
			expect({ refusedCode, refused, granted: calls }).toEqual({
				refusedCode: 'tool.not_authorized',
				refused: { profile: 0, vision: 0 },
				granted: { profile: 1, vision: 1 },
			});
		});
	}

	// ── identify_by_image: an EXTERNAL encoder is a spend, a local one is not ─
	function imageDeps(external: boolean, calls: { embed: number }): IdentifyByImageDeps {
		const provider: MultimodalEmbeddingProvider = {
			embedImage: async () => {
				calls.embed++;
				return [[1, 0, 0]];
			},
			embedTextForImageSearch: async () => [],
			dimension: () => 3,
			model: () => 'zzvision-encoder',
			provider: () => (external ? 'zzvision-cloud' : 'local'),
			isExternal: () => external,
		};
		return {
			...defaultIdentifyByImageDeps(),
			ragEnabled: () => true,
			mediaEnabled: () => true,
			buildProvider: () => provider,
			queryImagePartition: async () => [],
			filterAccessible: async (_principal, candidates) => candidates,
		};
	}
	const image = { action: 'identify_by_image', options: { image: PNG } } as unknown as Rqo;

	test.skip('identify_by_image, EXTERNAL encoder: ungranted → tool.not_authorized with ZERO embeds; the granted twin embeds — SKIPPED: tool_identify is withdrawn from the tool registry (WC-2026-10-29, provisional until its redesign)', async () => {
		const calls = { embed: 0 };
		const handler = buildIdentifyByImage(imageDeps(true, calls));
		const refused = await codeOf(handler(image, ctx(ids.control)));
		const refusedEmbeds = calls.embed;
		const granted = await codeOf(handler(image, ctx(ids.toolGranted)));
		expect({ refused, refusedEmbeds, grantedPasses: granted !== 'tool.not_authorized' }).toEqual({
			refused: 'tool.not_authorized',
			refusedEmbeds: 0,
			grantedPasses: true,
		});
		expect(calls.embed).toBe(1);
	});

	test('identify_by_image, LOCAL encoder: no spend, no grant asked — the ungranted caller is served', async () => {
		const calls = { embed: 0 };
		const code = await codeOf(
			buildIdentifyByImage(imageDeps(false, calls))(image, ctx(ids.control)),
		);
		expect({ passes: code !== 'tool.not_authorized', embeds: calls.embed }).toEqual({
			passes: true,
			embeds: 1,
		});
	});
});
