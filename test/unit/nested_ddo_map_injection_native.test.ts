/**
 * NESTED DDO_MAP INJECTION — the gate-completeness file of the nested-ddo_map
 * plan (W6). nested_ddo_data_native.test.ts (scratch `zzni`) carries the bulk
 * of the plan's Gates section; this file covers the bullets that had no gate of
 * their own, on its OWN scratch TLD `zzmj` (dropSituation is TLD-wide):
 *
 *  SECTION_LIST GOVERNS LIST AND TM. SL's own show is [A]; its `section_list`
 *    child declares [C, A] with its OWN sqo limit 1. A list read with no caller
 *    children takes the section_list config — data [C, A] on ONE target record
 *    (the list page), context show [C, A], sqo.limit 1. With caller children
 *    [B] only the SHOW is replaced: data [B], context show [B], and the sqo is
 *    still the section_list's (limit 1, one record). The SAME two legs through
 *    the Time Machine door (a dd15 column of SL over a recorded TM row: TM
 *    cells resolve as list, PHP trait.request_config_utils.php :270 swaps for
 *    tm too).
 *
 *  SLOTS (plan E3, per-slot replacement, PHP class.common.php :2629-2678): N's
 *    own config shows [A, B] and HIDES its dataframe DF, and has no choose.
 *    A choose-only caller CREATES the choose slot and leaves show + hide own; a
 *    show-only caller replaces show and keeps the own hidden DATAFRAME; a
 *    hide-only caller keeps the own show.
 *
 *  ENGINES (per api_engine, the caller's FIRST item of each engine): a
 *    multi-engine element takes each engine's children from the caller's item
 *    of THAT engine; an external-only element under a dedalo-only caller is
 *    unchanged and nothing throws; a caller carrying TWO dedalo items injects
 *    from the first only.
 *
 *  SHAPE: a chain of FIVE section hops (HOST —Q1→ S1 —Q2→ … —Q5→ S5) resolves
 *    with no depth gate from own configs (E1 at S5), and a caller map naming
 *    every level injects all the way down (E2 at S5, never E1; Q5's context
 *    shows [E2]) — injection over five levels, edit and list.
 *
 *  DUPLICATES / PER OCCURRENCE (owner decision (b)): one MID record under P1
 *    and P2. (1) Different caller maps: NM under P1 [B], under P2 [C] → two NM
 *    contexts keyed by caller_chain, each cell's children its own. (2) One slot
 *    EMPTY: P1's own config shows NM → [B] (no hide); P2's own config lists NM
 *    in show with NO children and declares NM's HIDE [C] — under P2 NM keeps
 *    its own show [A, B] (the empty slot is not a replacement) and takes the
 *    hide [C]; under P1 it shows [B] and hides nothing.
 *
 *  SELF (owner decision (c)): BAD's own map declares A under NM with
 *    `section_tipo: 'self'` (depth 2); GOOD declares it explicitly; GOOD's
 *    section_list LBAD declares a depth-2 `[{source:'self'}]` relative to its
 *    owner GOOD. A read of BAD skips A with an `ontology.ddo_self_refused`
 *    notice naming BAD, A and NM; the ONTOLOGY CHECK
 *    (relations/request_config/self_depth_check.ts) lists BAD and LBAD (owner
 *    GOOD) and never GOOD, and the registered reconcile reports the same.
 *    ONE RULE, TWO CONSUMERS — the shapes where the check could drift from the
 *    read: LP's section_list LLP names ITSELF as the first ddo's parent (the
 *    read takes parents verbatim: an orphan chain, kept, no notice — so the
 *    check lists nothing), and the section SKO declares a DIRECT
 *    request_config, so its section_list LKO (a depth-2 'self') is never
 *    swapped in by any read (build.ts sectionKeepsOwn) — the check skips it;
 *    the same for SOBJ, whose direct config is a non-array OBJECT (the read's
 *    keep-own test is isset, not the array shape). And the VIRTUAL fallback:
 *    SVR keeps a direct config, but its config-less virtual section SVV has no
 *    list node of its own, so SVV's list read takes SVR's section_list LVR and
 *    skips its depth-2 'self' with a RESPONSE notice (a section's own derived
 *    column map carries the notice too; only the doors with no response —
 *    TM scope, chain verifier, area boot, context-only build — log instead)
 *    — the check lists LVR (owner SVR).
 *
 * Situation: the scratch TLD `zzmj`, built through the engine's own write path
 * (ensureSituation → assertTestDatabase) and dropped after (residue 0).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Ddo } from '../../src/core/concepts/ddo.ts';
import { recordTimeMachine } from '../../src/core/db/time_machine.ts';
import { registerAllReconciles } from '../../src/core/reconcile/catalog.ts';
import { runReconcile } from '../../src/core/reconcile/registry.ts';
import { resolveElement } from '../../src/core/relations/element_node.ts';
import {
	type ElementNode,
	ElementNodeRegistry,
} from '../../src/core/relations/element_registry.ts';
import {
	DDO_SELF_DEPTH,
	scanDeepSelfDefinitions,
} from '../../src/core/relations/request_config/self_depth_check.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const TLD = 'zzmj';
const HOST = 'zzmj1';
const TARGET = 'zzmj2';
const TEXT_A = 'zzmj3';
const TEXT_B = 'zzmj4';
const TEXT_C = 'zzmj5';
/** N's hidden dataframe (own hide). */
const FRAME_N = 'zzmj6';
/** N: own show [A, B], own hide [DF], no choose. */
const PORTAL_N = 'zzmj7';
/** SL: own show [A]; its section_list LSL: show [C, A], sqo limit 1. */
const PORTAL_SL = 'zzmj8';
const LIST_SL = 'zzmj9';
/** ME: a dedalo item show [A] + an external item show [B]. */
const PORTAL_ME = 'zzmj10';
/** EX: one external item show [B]. */
const PORTAL_EX = 'zzmj11';
/** The five-hop chain: HOST —Q1→ S1 —Q2→ S2 —Q3→ S3 —Q4→ S4 —Q5→ S5 (E1 own, E2 caller). */
const CHAIN_PORTALS = ['zzmj12', 'zzmj14', 'zzmj16', 'zzmj18', 'zzmj20'] as const;
const CHAIN_SECTIONS = ['zzmj13', 'zzmj15', 'zzmj17', 'zzmj19', 'zzmj21'] as const;
const TEXT_E1 = 'zzmj22';
const TEXT_E2 = 'zzmj23';
/** One MID record under two host portals; NM on MID → TARGET, own show [A, B]. */
const PORTAL_P1 = 'zzmj24';
const PORTAL_P2 = 'zzmj25';
/** P3: own show [NM, C<NM] — the "different map" twin of P1's [NM, B<NM]. */
const PORTAL_P3 = 'zzmj31';
const MID = 'zzmj26';
const PORTAL_NM = 'zzmj27';
/** Decision (c): BAD (depth-2 'self'), GOOD (explicit), GOOD's section_list LBAD (depth-2 source self). */
const PORTAL_BAD = 'zzmj28';
const PORTAL_GOOD = 'zzmj29';
const LIST_BAD = 'zzmj30';
/**
 * relation_index related_list (verified against PHP —
 * WC-2026-11-04-nested-list-payload-growth): RI on TARGET has NO
 * request_config (the per-locator strategy); the pointing section REF2's
 * relation_list names a portal RPE with an EXPLICIT config (own show [A], and a
 * section_list showing [C]) and a literal TR.
 */
const REF2 = 'zzmj32';
const RELATION_LIST_REF2 = 'zzmj33';
const PORTAL_RPE = 'zzmj34';
const LIST_RPE = 'zzmj35';
const TEXT_R = 'zzmj36';
const INDEX_RI = 'zzmj37';
/** LP: own show [NM]; its section_list LLP names LLP ITSELF as NM's parent, then a 'self' A under NM. */
const PORTAL_LP = 'zzmj38';
const LIST_LP = 'zzmj39';
/** SKO: a SECTION with a direct request_config; its section_list LKO holds a depth-2 'self' (never read). */
const SECTION_KO = 'zzmj40';
const LIST_KO = 'zzmj41';
/** SOBJ: a SECTION whose direct request_config is a non-array OBJECT (isset keeps it); its LOBJ holds a depth-2 'self' (never read). */
const SECTION_OBJ = 'zzmj42';
const LIST_OBJ = 'zzmj43';
/** SVR keeps a direct config, but its config-less VIRTUAL section SVV has no list node: SVV's list read takes LVR (a depth-2 'self'). */
const SECTION_VR = 'zzmj44';
const LIST_VR = 'zzmj45';
const SECTION_VV = 'zzmj46';
/** SRL: a REAL section with no config of its own; its section_list LRL holds a depth-2 'self' (a section-OWNED map). */
const SECTION_RL = 'zzmj47';
const LIST_RL = 'zzmj48';
/** A non-dedalo engine name (attached nothing: no api_config on TARGET). */
// two section_list children under ONE portal: only the FIRST by order_number
// is ever read (build.ts findSectionListChild) — the second's depth-2 'self'
// is read by nobody, so neither the read nor the check reports it
const PORTAL_TL = 'zzmj49';
const LIST_TL1 = 'zzmj50';
const LIST_TL2 = 'zzmj51';
const EXT_ENGINE = 'zzmj_ext';

const HOST_ID = 1;
const TARGET_IDS = [1, 2, 3] as const;
const MID_ID = 1;

const locators = (tipo: string, sectionTipo: string, ids: readonly number[]) =>
	ids.map((sectionId, index) => ({
		id: index + 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: tipo,
	}));

const textValue = (value: string) => [{ id: 1, lang: 'lg-nolan', value }];

/** One config item over `section` with the given slots. */
const configItem = (
	section: string,
	slots: { show?: unknown[]; hide?: unknown[]; limit?: number; api_engine?: string },
) => ({
	...(slots.api_engine !== undefined ? { api_engine: slots.api_engine, type: 'main' } : {}),
	sqo: {
		section_tipo: [{ value: [section], source: 'section' }],
		...(slots.limit !== undefined ? { limit: slots.limit } : {}),
	},
	show: { ddo_map: slots.show ?? [] },
	...(slots.hide !== undefined ? { hide: { ddo_map: slots.hide } } : {}),
});

const config = (...items: unknown[]) => ({ source: { request_config: items } });

const own = (tipo: string, section: string) => ({ tipo, parent: 'self', section_tipo: section });

const S = situation({
	name: 'nested ddo_map injection',
	tld: TLD,
	nodes: [
		{ tipo: HOST, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: TARGET, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: TEXT_A, parent: TARGET, model: 'component_input_text', order_number: 1 },
		{ tipo: TEXT_B, parent: TARGET, model: 'component_input_text', order_number: 2 },
		{ tipo: TEXT_C, parent: TARGET, model: 'component_input_text', order_number: 3 },
		{
			tipo: PORTAL_N,
			parent: HOST,
			model: 'component_portal',
			order_number: 1,
			properties: config(
				configItem(TARGET, {
					show: [own(TEXT_A, TARGET), own(TEXT_B, TARGET)],
					hide: [{ tipo: FRAME_N, parent: 'self', section_tipo: 'self' }],
				}),
			),
		},
		{
			tipo: FRAME_N,
			parent: PORTAL_N,
			model: 'component_dataframe',
			properties: config(configItem(TARGET, { show: [own(TEXT_C, TARGET)] })),
		},
		{
			tipo: PORTAL_SL,
			parent: HOST,
			model: 'component_portal',
			order_number: 2,
			properties: config(configItem(TARGET, { show: [own(TEXT_A, TARGET)] })),
		},
		{
			tipo: LIST_SL,
			parent: PORTAL_SL,
			model: 'section_list',
			properties: config(
				configItem(TARGET, { show: [own(TEXT_C, TARGET), own(TEXT_A, TARGET)], limit: 1 }),
			),
		},
		{
			tipo: PORTAL_ME,
			parent: HOST,
			model: 'component_portal',
			order_number: 3,
			properties: config(
				configItem(TARGET, { show: [own(TEXT_A, TARGET)] }),
				configItem(TARGET, { show: [own(TEXT_B, TARGET)], api_engine: EXT_ENGINE }),
			),
		},
		{
			tipo: PORTAL_EX,
			parent: HOST,
			model: 'component_portal',
			order_number: 4,
			properties: config(
				configItem(TARGET, { show: [own(TEXT_B, TARGET)], api_engine: EXT_ENGINE }),
			),
		},
		...CHAIN_SECTIONS.flatMap((section, k) => {
			const portal = CHAIN_PORTALS[k] as string;
			const ownerSection = k === 0 ? HOST : (CHAIN_SECTIONS[k - 1] as string);
			const next = CHAIN_PORTALS[k + 1];
			return [
				{ tipo: section, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
				{
					tipo: portal,
					parent: ownerSection,
					model: 'component_portal',
					order_number: 10 + k,
					properties: config(
						configItem(section, {
							show: [next === undefined ? own(TEXT_E1, section) : own(next, section)],
						}),
					),
				},
			];
		}),
		{
			tipo: TEXT_E1,
			parent: CHAIN_SECTIONS[4],
			model: 'component_input_text',
			order_number: 1,
		},
		{
			tipo: TEXT_E2,
			parent: CHAIN_SECTIONS[4],
			model: 'component_input_text',
			order_number: 2,
		},
		{ tipo: MID, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL_NM,
			parent: MID,
			model: 'component_portal',
			order_number: 1,
			properties: config(configItem(TARGET, { show: [own(TEXT_A, TARGET), own(TEXT_B, TARGET)] })),
		},
		{
			tipo: PORTAL_P1,
			parent: HOST,
			model: 'component_portal',
			order_number: 20,
			properties: config(
				configItem(MID, {
					show: [own(PORTAL_NM, MID), { tipo: TEXT_B, parent: PORTAL_NM, section_tipo: TARGET }],
				}),
			),
		},
		{
			tipo: PORTAL_P2,
			parent: HOST,
			model: 'component_portal',
			order_number: 21,
			properties: config(
				configItem(MID, {
					show: [own(PORTAL_NM, MID)],
					hide: [{ tipo: TEXT_C, parent: PORTAL_NM, section_tipo: TARGET }],
				}),
			),
		},
		{
			tipo: PORTAL_P3,
			parent: HOST,
			model: 'component_portal',
			order_number: 22,
			properties: config(
				configItem(MID, {
					show: [own(PORTAL_NM, MID), { tipo: TEXT_C, parent: PORTAL_NM, section_tipo: TARGET }],
				}),
			),
		},
		{
			tipo: PORTAL_BAD,
			parent: HOST,
			model: 'component_portal',
			order_number: 30,
			properties: config(
				configItem(MID, {
					show: [
						own(PORTAL_NM, MID),
						{ tipo: TEXT_A, parent: PORTAL_NM, section_tipo: 'self' },
						{ tipo: TEXT_B, parent: PORTAL_NM, section_tipo: TARGET },
					],
				}),
			),
		},
		{
			tipo: PORTAL_GOOD,
			parent: HOST,
			model: 'component_portal',
			order_number: 31,
			properties: config(
				configItem(MID, {
					show: [own(PORTAL_NM, MID), { tipo: TEXT_A, parent: PORTAL_NM, section_tipo: TARGET }],
				}),
			),
		},
		{
			tipo: LIST_BAD,
			parent: PORTAL_GOOD,
			model: 'section_list',
			properties: config(
				configItem(MID, {
					show: [
						{ tipo: PORTAL_NM, parent: PORTAL_GOOD, section_tipo: MID },
						{ tipo: TEXT_B, parent: PORTAL_NM, section_tipo: [{ source: 'self' }] },
					],
				}),
			),
		},
		{
			tipo: PORTAL_LP,
			parent: HOST,
			model: 'component_portal',
			order_number: 32,
			properties: config(configItem(MID, { show: [own(PORTAL_NM, MID)] })),
		},
		{
			tipo: LIST_LP,
			parent: PORTAL_LP,
			model: 'section_list',
			properties: config(
				configItem(MID, {
					show: [
						{ tipo: PORTAL_NM, parent: LIST_LP, section_tipo: MID },
						{ tipo: TEXT_A, parent: PORTAL_NM, section_tipo: 'self' },
					],
				}),
			),
		},
		{
			tipo: SECTION_KO,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: 'test24' }],
			properties: config(configItem(MID, { show: [own(PORTAL_NM, MID)] })),
		},
		{
			tipo: LIST_KO,
			parent: SECTION_KO,
			model: 'section_list',
			properties: config(
				configItem(MID, {
					show: [own(PORTAL_NM, MID), { tipo: TEXT_A, parent: PORTAL_NM, section_tipo: 'self' }],
				}),
			),
		},
		{
			tipo: SECTION_OBJ,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: 'test24' }],
			properties: { source: { request_config: { legacy: true } } },
		},
		{
			tipo: LIST_OBJ,
			parent: SECTION_OBJ,
			model: 'section_list',
			properties: config(
				configItem(MID, {
					show: [own(PORTAL_NM, MID), { tipo: TEXT_A, parent: PORTAL_NM, section_tipo: 'self' }],
				}),
			),
		},
		{
			tipo: SECTION_VR,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: 'test24' }],
			properties: config(configItem(TARGET, { show: [own(TEXT_B, TARGET)] })),
		},
		{
			tipo: LIST_VR,
			parent: SECTION_VR,
			model: 'section_list',
			// show: a 'self'-rooted chain (every reader agrees). hide: rooted on the
			// LITERAL virtual tipo SVV — counted by SVV's read (its ownerTipo), so
			// refused. search: rooted on the LITERAL real tipo SVR — an orphan for
			// SVV, the only reader (SVR keeps its own config), so kept.
			properties: config({
				...configItem(MID, {
					show: [own(PORTAL_NM, MID), { tipo: TEXT_A, parent: PORTAL_NM, section_tipo: 'self' }],
					hide: [
						{ tipo: PORTAL_NM, parent: SECTION_VV, section_tipo: MID },
						{ tipo: TEXT_C, parent: PORTAL_NM, section_tipo: 'self' },
					],
				}),
				search: {
					ddo_map: [
						{ tipo: PORTAL_NM, parent: SECTION_VR, section_tipo: MID },
						{ tipo: TEXT_B, parent: PORTAL_NM, section_tipo: 'self' },
					],
				},
			}),
		},
		{ tipo: SECTION_VV, parent: 'test1', model: 'section', relations: [{ tipo: SECTION_VR }] },
		{ tipo: SECTION_RL, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: LIST_RL,
			parent: SECTION_RL,
			model: 'section_list',
			properties: config(
				configItem(MID, {
					show: [own(PORTAL_NM, MID), { tipo: TEXT_A, parent: PORTAL_NM, section_tipo: 'self' }],
				}),
			),
		},
		{
			tipo: PORTAL_TL,
			parent: HOST,
			model: 'component_portal',
			order_number: 33,
			properties: config(configItem(MID, { show: [own(PORTAL_NM, MID)] })),
		},
		{
			tipo: LIST_TL1,
			parent: PORTAL_TL,
			model: 'section_list',
			order_number: 1,
			properties: config(
				configItem(MID, {
					show: [own(PORTAL_NM, MID), { tipo: TEXT_B, parent: PORTAL_NM, section_tipo: TARGET }],
				}),
			),
		},
		{
			tipo: LIST_TL2,
			parent: PORTAL_TL,
			model: 'section_list',
			order_number: 2,
			properties: config(
				configItem(MID, {
					show: [own(PORTAL_NM, MID), { tipo: TEXT_A, parent: PORTAL_NM, section_tipo: 'self' }],
				}),
			),
		},
		{ tipo: REF2, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL_RPE,
			parent: REF2,
			model: 'component_portal',
			order_number: 1,
			properties: config(configItem(TARGET, { show: [own(TEXT_A, TARGET)] })),
		},
		{
			tipo: LIST_RPE,
			parent: PORTAL_RPE,
			model: 'section_list',
			properties: config(configItem(TARGET, { show: [own(TEXT_C, TARGET)] })),
		},
		{ tipo: TEXT_R, parent: REF2, model: 'component_input_text', order_number: 2 },
		{
			tipo: RELATION_LIST_REF2,
			parent: REF2,
			model: 'relation_list',
			relations: [{ tipo: PORTAL_RPE }, { tipo: TEXT_R }],
		},
		{
			tipo: INDEX_RI,
			parent: TARGET,
			model: 'component_relation_index',
			order_number: 9,
			properties: { config_relation: { relation_type: 'dd151' } },
		},
	],
	records: [
		{
			section_tipo: REF2,
			section_id: 1,
			columns: {
				string: { [TEXT_R]: textValue('R1') },
				relation: { [PORTAL_RPE]: locators(PORTAL_RPE, TARGET, [1]) },
			},
		},
		{
			section_tipo: HOST,
			section_id: HOST_ID,
			columns: {
				relation: {
					[PORTAL_N]: locators(PORTAL_N, TARGET, TARGET_IDS),
					[PORTAL_SL]: locators(PORTAL_SL, TARGET, TARGET_IDS),
					[CHAIN_PORTALS[0]]: locators(CHAIN_PORTALS[0], CHAIN_SECTIONS[0], [1]),
					[PORTAL_P1]: locators(PORTAL_P1, MID, [MID_ID]),
					[PORTAL_P2]: locators(PORTAL_P2, MID, [MID_ID]),
					[PORTAL_P3]: locators(PORTAL_P3, MID, [MID_ID]),
					[PORTAL_BAD]: locators(PORTAL_BAD, MID, [MID_ID]),
					[PORTAL_GOOD]: locators(PORTAL_GOOD, MID, [MID_ID]),
					[PORTAL_LP]: locators(PORTAL_LP, MID, [MID_ID]),
					[PORTAL_TL]: locators(PORTAL_TL, MID, [MID_ID]),
				},
			},
		},
		...TARGET_IDS.map((id) => ({
			section_tipo: TARGET,
			section_id: id,
			columns: {
				string: {
					[TEXT_A]: textValue(`A${id}`),
					[TEXT_B]: textValue(`B${id}`),
					[TEXT_C]: textValue(`C${id}`),
				},
			},
		})),
		{
			section_tipo: MID,
			section_id: MID_ID,
			columns: { relation: { [PORTAL_NM]: locators(PORTAL_NM, TARGET, [1, 2]) } },
		},
		...CHAIN_SECTIONS.map((section, k) => {
			const next = CHAIN_PORTALS[k + 1];
			return next === undefined
				? {
						section_tipo: section,
						section_id: 1,
						columns: { string: { [TEXT_E1]: textValue('E1'), [TEXT_E2]: textValue('E2') } },
					}
				: {
						section_tipo: section,
						section_id: 1,
						columns: {
							relation: {
								[next]: locators(next, CHAIN_SECTIONS[k + 1] as string, [1]),
							},
						},
					};
		}),
	],
});

let tsContext: Record<string, unknown>;

beforeAll(async () => {
	await ensureSituation(S);
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	tsContext = {
		requestId: 'nested-ddo-map-injection',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	};
}, 60000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
	// Every section read of a scratch section logs a dd542 LOAD row naming its
	// tipo (dd_core_api logReadActivity); dropSituation neither sweeps nor
	// counts them (test/helpers/activity_rows.ts) — sweep, then assert none left.
	const tipos = S.nodes.map((node) => node.tipo);
	for (const tipo of tipos) await sweepActivityRows(tipo);
	let activityResidue = 0;
	for (const tipo of tipos) activityResidue += await countActivityRows(tipo);
	expect(activityResidue).toBe(0);
});

/* ---------------------------------------------------------------- helpers */

interface Item {
	typo?: unknown;
	tipo?: unknown;
	mode?: unknown;
	from_component_tipo?: unknown;
	section_tipo?: unknown;
	section_id?: unknown;
	caller_chain?: unknown;
}

interface ContextEntry {
	tipo?: unknown;
	section_tipo?: unknown;
	caller_chain?: string;
	request_config?: {
		api_engine?: string;
		show?: { ddo_map?: { tipo: string }[] } | null;
		hide?: { ddo_map?: { tipo: string }[] } | null;
		sqo?: { limit?: unknown };
	}[];
}

interface Notice {
	code?: string;
	details?: Record<string, unknown>;
}

interface Answer {
	ok: boolean;
	items: Item[];
	context: ContextEntry[];
	notices: Notice[];
}

/** A section read of HOST record 1 in `mode` with the column map `ddoMap`. */
async function readHost(mode: 'list' | 'edit', ddoMap: Record<string, unknown>[]): Promise<Answer> {
	const rqo = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: HOST,
			section_tipo: HOST,
			action: 'search',
			mode,
			lang: 'lg-nolan',
		},
		sqo: {
			section_tipo: [HOST],
			limit: 1,
			offset: 0,
			filter_by_locators: [{ section_tipo: HOST, section_id: String(HOST_ID) }],
		},
		show: { ddo_map: ddoMap },
	};
	const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
		ok?: boolean;
		data?: { data?: Item[]; context?: ContextEntry[] };
		notices?: Notice[];
	};
	return {
		ok: body.ok !== false,
		items: (body.data?.data ?? []).filter((item) => item.typo !== 'sections'),
		context: body.data?.context ?? [],
		notices: body.notices ?? [],
	};
}

/**
 * A Time Machine read (dd15, the TM door — root) of HOST's per-component rows
 * of `componentTipo`, with the column map `ddoMap`.
 */
async function readTm(componentTipo: string, ddoMap: Record<string, unknown>[]): Promise<Answer> {
	const rqo = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			model: 'section',
			tipo: 'dd15',
			section_tipo: 'dd15',
			mode: 'list',
			lang: 'lg-nolan',
			session_save: false,
		},
		sqo: {
			mode: 'tm',
			limit: 10,
			offset: 0,
			order: [{ direction: 'DESC', path: [{ component_tipo: 'id' }] }],
			skip_projects_filter: true,
			section_tipo: [HOST],
			filter_by_locators: [{ section_tipo: HOST, section_id: HOST_ID, tipo: componentTipo }],
		},
		show: { ddo_map: ddoMap },
	};
	const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
		ok?: boolean;
		data?: { data?: Item[]; context?: ContextEntry[] };
		notices?: Notice[];
	};
	return {
		ok: body.ok !== false,
		items: (body.data?.data ?? []).filter((item) => item.typo !== 'sections'),
		context: body.data?.context ?? [],
		notices: body.notices ?? [],
	};
}

const contextsOf = (context: ContextEntry[], tipo: string, sectionTipo: string) =>
	context.filter((entry) => entry.tipo === tipo && entry.section_tipo === sectionTipo);

const slotOf = (entry: ContextEntry | undefined, slot: 'show' | 'hide'): string[] =>
	(entry?.request_config?.[0]?.[slot]?.ddo_map ?? []).map((ddo) => ddo.tipo);

/** The distinct tipos emitted at `sectionTipo` for record `sectionId` (any when omitted). */
const tiposAt = (items: Item[], sectionTipo: string, sectionId?: number): Set<unknown> =>
	new Set(
		items
			.filter(
				(item) =>
					item.section_tipo === sectionTipo &&
					(sectionId === undefined || Number(item.section_id) === sectionId),
			)
			.map((item) => item.tipo),
	);

/** A fabricated PARENT node whose effective config is exactly `items`. */
function parentWithItems(items: Record<string, unknown>[]): ElementNode {
	return {
		key: 'probe-parent',
		parentKey: null,
		tipo: HOST,
		section_tipo: HOST,
		mode: 'list',
		view: null,
		lang: 'lg-nolan',
		limit: null,
		parent_grouper: null,
		properties: null,
		effectiveConfig: items.map((item) => ({
			api_engine: 'dedalo',
			type: 'main',
			...item,
		})) as never,
		configSource: 'root',
		injected: false,
		injectedSlots: [],
		dataChildrenInjected: false,
		oneLevel: false,
		childOrigin: 'ontology',
		children: [],
	};
}

/** resolveElement of `tipo` on the host against the real zzmj ontology. */
function resolveOnHost(
	tipo: string,
	parentNode: ElementNode | null,
	mode: 'list' | 'edit' = 'list',
): Promise<ElementNode> {
	return resolveElement({
		ddo: { tipo, section_tipo: HOST, parent: HOST } as unknown as Ddo,
		parentNode,
		ownerSectionTipo: HOST,
		ownerSectionId: HOST_ID,
		mode,
		lang: 'lg-nolan',
		registry: new ElementNodeRegistry(),
		model: 'component_portal',
	});
}

/** The tipos of `slot` of the node's config item `index`. */
const nodeSlot = (
	node: ElementNode,
	slot: 'show' | 'search' | 'choose' | 'hide',
	index = 0,
): string[] | null => {
	const block = (node.effectiveConfig[index] as Record<string, unknown> | undefined)?.[slot] as
		| { ddo_map?: { tipo: string }[] }
		| null
		| undefined;
	return block === null || block === undefined
		? null
		: (block.ddo_map ?? []).map((ddo) => ddo.tipo);
};

const childOf = (tipo: string, parent: string, section = TARGET) => ({
	tipo,
	parent,
	section_tipo: section,
});

/* ------------------------------------------------------------------ gates */

describe('section_list governs list and TM (own sqo + limit); caller children replace only the show', () => {
	test('preconditions: SL edit keeps its OWN show [A] (the section_list is a list device)', async () => {
		const node = await resolveOnHost(PORTAL_SL, null, 'edit');
		expect(nodeSlot(node, 'show')).toEqual([TEXT_A]);
	});

	test('list, no caller children: data [C, A] on ONE record, context show [C, A], sqo.limit 1', async () => {
		const { ok, items, context } = await readHost('list', [
			{ tipo: PORTAL_SL, section_tipo: HOST, parent: HOST, mode: 'list' },
		]);
		expect(ok).toBe(true);
		const entry = contextsOf(context, PORTAL_SL, HOST)[0];
		expect(entry).toBeDefined();
		expect(slotOf(entry, 'show')).toEqual([TEXT_C, TEXT_A]);
		expect(entry?.request_config?.[0]?.sqo?.limit).toBe(1);
		const emitted = items.filter((item) => item.section_tipo === TARGET);
		expect(emitted.length).toBeGreaterThan(0);
		// the section_list's page: one TARGET record, its C and A — never B
		expect(new Set(emitted.map((item) => Number(item.section_id)))).toEqual(new Set([1]));
		expect(tiposAt(items, TARGET)).toEqual(new Set([TEXT_C, TEXT_A]));
		const order = emitted.map((item) => item.tipo);
		expect(order.indexOf(TEXT_C)).toBeLessThan(order.indexOf(TEXT_A));
	});

	test('list, caller children [B]: data [B], context show [B] — the sqo is STILL the section_list one (limit 1)', async () => {
		const { ok, items, context } = await readHost('list', [
			{ tipo: PORTAL_SL, section_tipo: HOST, parent: HOST, mode: 'list' },
			{ tipo: TEXT_B, section_tipo: TARGET, parent: PORTAL_SL, mode: 'list' },
		]);
		expect(ok).toBe(true);
		const entry = contextsOf(context, PORTAL_SL, HOST)[0];
		expect(entry).toBeDefined();
		expect(slotOf(entry, 'show')).toEqual([TEXT_B]);
		expect(entry?.request_config?.[0]?.sqo?.limit).toBe(1);
		const emitted = items.filter((item) => item.section_tipo === TARGET);
		expect(emitted.length).toBeGreaterThan(0);
		expect(tiposAt(items, TARGET)).toEqual(new Set([TEXT_B]));
		expect(new Set(emitted.map((item) => Number(item.section_id)))).toEqual(new Set([1]));
	});

	test('TM, no caller children: the dd15 column of SL takes the section_list — show [C, A], sqo.limit 1, one record', async () => {
		await recordTimeMachine(
			{
				sectionTipo: HOST,
				sectionId: HOST_ID,
				componentTipo: PORTAL_SL,
				lang: 'lg-nolan',
				userId: -1,
				data: locators(PORTAL_SL, TARGET, TARGET_IDS),
			},
			'2026-11-04 10:00:00',
		);
		const { ok, items, context } = await readTm(PORTAL_SL, [
			{ tipo: PORTAL_SL, section_tipo: HOST },
		]);
		expect(ok).toBe(true);
		const column = contextsOf(context, PORTAL_SL, 'dd15');
		expect(column).toHaveLength(1);
		expect(slotOf(column[0], 'show')).toEqual([TEXT_C, TEXT_A]);
		expect(column[0]?.request_config?.[0]?.sqo?.limit).toBe(1);
		const emitted = items.filter((item) => item.section_tipo === TARGET);
		expect(emitted.length).toBeGreaterThan(0);
		expect(tiposAt(items, TARGET)).toEqual(new Set([TEXT_C, TEXT_A]));
		expect(new Set(emitted.map((item) => Number(item.section_id))).size).toBe(1);
	});

	test('TM, caller children [B]: show [B] — the sqo is STILL the section_list one (limit 1)', async () => {
		const { ok, items, context } = await readTm(PORTAL_SL, [
			{ tipo: PORTAL_SL, section_tipo: HOST },
			{ tipo: TEXT_B, section_tipo: TARGET, parent: PORTAL_SL },
		]);
		expect(ok).toBe(true);
		const column = contextsOf(context, PORTAL_SL, 'dd15');
		expect(column).toHaveLength(1);
		expect(slotOf(column[0], 'show')).toEqual([TEXT_B]);
		expect(column[0]?.request_config?.[0]?.sqo?.limit).toBe(1);
		const emitted = items.filter((item) => item.section_tipo === TARGET);
		expect(emitted.length).toBeGreaterThan(0);
		expect(tiposAt(items, TARGET)).toEqual(new Set([TEXT_B]));
		expect(new Set(emitted.map((item) => Number(item.section_id))).size).toBe(1);
	});
});

describe('slots: per-slot replacement (plan E3)', () => {
	test('preconditions: N own show [A, B], hide [DF], no choose', async () => {
		const node = await resolveOnHost(PORTAL_N, null);
		expect(nodeSlot(node, 'show')).toEqual([TEXT_A, TEXT_B]);
		expect(nodeSlot(node, 'hide')).toEqual([FRAME_N]);
		expect(nodeSlot(node, 'choose')).toBeNull();
	});

	test('a choose-only caller CREATES the choose slot; show and hide stay own', async () => {
		const node = await resolveOnHost(
			PORTAL_N,
			parentWithItems([
				{
					show: { ddo_map: [own(PORTAL_N, HOST)] },
					choose: { ddo_map: [childOf(TEXT_C, PORTAL_N)] },
				},
			]),
		);
		expect(nodeSlot(node, 'choose')).toEqual([TEXT_C]);
		expect(nodeSlot(node, 'show')).toEqual([TEXT_A, TEXT_B]);
		expect(nodeSlot(node, 'hide')).toEqual([FRAME_N]);
		expect(node.injectedSlots).toEqual(['choose']);
		expect(node.dataChildrenInjected).toBe(false);
	});

	test('a show-only caller replaces show and KEEPS the own hidden dataframe', async () => {
		const node = await resolveOnHost(
			PORTAL_N,
			parentWithItems([{ show: { ddo_map: [own(PORTAL_N, HOST), childOf(TEXT_C, PORTAL_N)] } }]),
		);
		expect(nodeSlot(node, 'show')).toEqual([TEXT_C]);
		expect(nodeSlot(node, 'hide')).toEqual([FRAME_N]);
		expect(node.injectedSlots).toEqual(['show']);
	});

	test('a hide-only caller replaces hide and keeps the own show', async () => {
		const node = await resolveOnHost(
			PORTAL_N,
			parentWithItems([
				{
					show: { ddo_map: [own(PORTAL_N, HOST)] },
					hide: { ddo_map: [childOf(TEXT_C, PORTAL_N)] },
				},
			]),
		);
		expect(nodeSlot(node, 'show')).toEqual([TEXT_A, TEXT_B]);
		expect(nodeSlot(node, 'hide')).toEqual([TEXT_C]);
	});
});

describe('engines: per api_engine, the first caller item of each engine', () => {
	test('a multi-engine element takes each engine from the caller item of THAT engine', async () => {
		const ownNode = await resolveOnHost(PORTAL_ME, null);
		expect(ownNode.effectiveConfig.map((item) => item.api_engine ?? 'dedalo')).toEqual([
			'dedalo',
			EXT_ENGINE,
		]);
		const node = await resolveOnHost(
			PORTAL_ME,
			parentWithItems([
				{ show: { ddo_map: [own_(PORTAL_ME), childOf(TEXT_C, PORTAL_ME)] } },
				{
					api_engine: EXT_ENGINE,
					show: { ddo_map: [own_(PORTAL_ME), childOf(TEXT_A, PORTAL_ME)] },
				},
			]),
		);
		expect(node.effectiveConfig.map((item) => item.api_engine ?? 'dedalo')).toEqual([
			'dedalo',
			EXT_ENGINE,
		]);
		expect(nodeSlot(node, 'show', 0)).toEqual([TEXT_C]);
		expect(nodeSlot(node, 'show', 1)).toEqual([TEXT_A]);
	});

	test('an EXTERNAL-only element under a dedalo-only caller is unchanged, and nothing throws', async () => {
		const ownNode = await resolveOnHost(PORTAL_EX, null);
		const node = await resolveOnHost(
			PORTAL_EX,
			parentWithItems([{ show: { ddo_map: [own_(PORTAL_EX), childOf(TEXT_C, PORTAL_EX)] } }]),
		);
		expect(node.effectiveConfig.map((item) => item.api_engine)).toEqual([EXT_ENGINE]);
		expect(nodeSlot(node, 'show')).toEqual([TEXT_B]);
		expect(JSON.stringify(node.effectiveConfig)).toBe(JSON.stringify(ownNode.effectiveConfig));
	});

	test('a caller with TWO dedalo items injects from the FIRST only', async () => {
		const node = await resolveOnHost(
			PORTAL_N,
			parentWithItems([
				{ show: { ddo_map: [own_(PORTAL_N), childOf(TEXT_B, PORTAL_N)] } },
				{ show: { ddo_map: [own_(PORTAL_N), childOf(TEXT_C, PORTAL_N)] } },
			]),
		);
		expect(nodeSlot(node, 'show')).toEqual([TEXT_B]);
	});
});

/** A first-level ddo of the probe caller (its section is the host). */
function own_(tipo: string): Record<string, unknown> {
	return own(tipo, HOST);
}

describe('shape: five section hops, injection all the way down', () => {
	/** The caller map naming every level: Q1 < HOST, Q(k+1) < Qk, E2 < Q5. */
	const deepMap = (mode: 'list' | 'edit') => [
		...CHAIN_PORTALS.map((portal, k) => ({
			tipo: portal,
			section_tipo: k === 0 ? HOST : CHAIN_SECTIONS[k - 1],
			parent: k === 0 ? HOST : CHAIN_PORTALS[k - 1],
			mode: k === 0 ? mode : 'list',
		})),
		{ tipo: TEXT_E2, section_tipo: CHAIN_SECTIONS[4], parent: CHAIN_PORTALS[4], mode: 'list' },
	];
	const S5 = CHAIN_SECTIONS[4] as string;

	for (const mode of ['edit', 'list'] as const) {
		test(`${mode}: own configs alone resolve the 5-hop chain (no depth gate) — E1 at S5`, async () => {
			const { ok, items } = await readHost(mode, [
				{ tipo: CHAIN_PORTALS[0], section_tipo: HOST, parent: HOST, mode },
			]);
			expect(ok).toBe(true);
			for (const section of CHAIN_SECTIONS.slice(0, 4)) {
				expect(tiposAt(items, section).size).toBeGreaterThan(0);
			}
			expect(tiposAt(items, S5)).toEqual(new Set([TEXT_E1]));
		});

		test(`${mode}: a caller map naming every level injects five levels down — E2 at S5, never E1; Q5's context shows [E2]`, async () => {
			const { ok, items, context } = await readHost(mode, deepMap(mode));
			expect(ok).toBe(true);
			expect(tiposAt(items, S5)).toEqual(new Set([TEXT_E2]));
			const q5 = contextsOf(context, CHAIN_PORTALS[4], CHAIN_SECTIONS[3]);
			expect(q5).toHaveLength(1);
			expect(slotOf(q5[0], 'show')).toEqual([TEXT_E2]);
			expect(contextsOf(context, TEXT_E1, S5)).toHaveLength(0);
			expect(contextsOf(context, TEXT_E2, S5)).toHaveLength(1);
		});
	}
});

/** NM cells of a read: each NM item's chain and the TARGET tipos emitted after it. */
function nmCells(items: Item[]): { chain: unknown; children: Set<unknown> }[] {
	const portals = new Set<unknown>([PORTAL_P1, PORTAL_P2, PORTAL_P3, PORTAL_NM]);
	return items.flatMap((item, index) => {
		if (item.tipo !== PORTAL_NM || item.section_tipo !== MID) return [];
		const children = new Set<unknown>();
		for (const next of items.slice(index + 1)) {
			if (portals.has(next.tipo)) break;
			if (next.section_tipo === TARGET) children.add(next.tipo);
		}
		return [{ chain: item.caller_chain, children }];
	});
}

describe('duplicates (b): one MID record under P1 and P2', () => {
	test('different caller maps — NM under P1 (own [NM, B<NM]) and P3 (own [NM, C<NM]): two contexts, each cell its own columns', async () => {
		const { ok, items, context } = await readHost('list', [
			{ tipo: PORTAL_P1, section_tipo: HOST, parent: HOST, mode: 'list' },
			{ tipo: PORTAL_P3, section_tipo: HOST, parent: HOST, mode: 'list' },
		]);
		expect(ok).toBe(true);
		const nm = contextsOf(context, PORTAL_NM, MID);
		expect(nm).toHaveLength(2);
		const byChain = new Map(nm.map((entry) => [entry.caller_chain, slotOf(entry, 'show')]));
		expect(byChain.get(PORTAL_P1)).toEqual([TEXT_B]);
		expect(byChain.get(PORTAL_P3)).toEqual([TEXT_C]);
		const cells = nmCells(items);
		expect(cells).toHaveLength(2);
		for (const cell of cells) {
			expect(cell.children.size).toBeGreaterThan(0);
			expect(cell.children).toEqual(new Set(byChain.get(cell.chain as string)));
		}
		// A is nobody's column here
		expect(contextsOf(context, TEXT_A, TARGET)).toHaveLength(0);
	});

	test('ONE flat map naming NM under both parents: the children match by PARENT only, so both NM share [B, C] (PHP get_children_recursive) — one context', async () => {
		const { ok, items, context } = await readHost('list', [
			{ tipo: PORTAL_P1, section_tipo: HOST, parent: HOST, mode: 'list' },
			{ tipo: PORTAL_NM, section_tipo: MID, parent: PORTAL_P1, mode: 'list' },
			{ tipo: TEXT_B, section_tipo: TARGET, parent: PORTAL_NM, mode: 'list' },
			{ tipo: PORTAL_P3, section_tipo: HOST, parent: HOST, mode: 'list' },
			{ tipo: PORTAL_NM, section_tipo: MID, parent: PORTAL_P3, mode: 'list' },
			{ tipo: TEXT_C, section_tipo: TARGET, parent: PORTAL_NM, mode: 'list' },
		]);
		expect(ok).toBe(true);
		const nm = contextsOf(context, PORTAL_NM, MID);
		expect(nm).toHaveLength(1);
		expect(slotOf(nm[0], 'show')).toEqual([TEXT_B, TEXT_C]);
		const cells = nmCells(items);
		expect(cells).toHaveLength(2);
		for (const cell of cells) expect(cell.children).toEqual(new Set([TEXT_B, TEXT_C]));
	});

	test('one slot EMPTY — P2 names NM with no show children but a hide [C]: own show [A, B] + hide [C]; P1 shows [B], hides nothing', async () => {
		const { ok, items, context } = await readHost('list', [
			{ tipo: PORTAL_P1, section_tipo: HOST, parent: HOST, mode: 'list' },
			{ tipo: PORTAL_P2, section_tipo: HOST, parent: HOST, mode: 'list' },
		]);
		expect(ok).toBe(true);
		const nm = contextsOf(context, PORTAL_NM, MID);
		expect(nm).toHaveLength(2);
		const p1 = nm.find((entry) => entry.caller_chain === PORTAL_P1);
		const p2 = nm.find((entry) => entry.caller_chain === PORTAL_P2);
		expect(p1).toBeDefined();
		expect(p2).toBeDefined();
		expect(slotOf(p1, 'show')).toEqual([TEXT_B]);
		expect(slotOf(p1, 'hide')).toEqual([]);
		expect(slotOf(p2, 'show')).toEqual([TEXT_A, TEXT_B]);
		expect(slotOf(p2, 'hide')).toEqual([TEXT_C]);
		const cells = new Map(nmCells(items).map((cell) => [cell.chain, cell.children]));
		expect(cells.get(PORTAL_P1)).toEqual(new Set([TEXT_B]));
		expect(cells.get(PORTAL_P2)).toEqual(new Set([TEXT_A, TEXT_B, TEXT_C]));
	});
});

describe("self (c): a level >= 2 'self' is refused at read AND found by the ontology check", () => {
	test('a read of BAD skips A under NM with a typed notice naming BAD, A and NM; GOOD shows A', async () => {
		const bad = await readHost('list', [
			{ tipo: PORTAL_BAD, section_tipo: HOST, parent: HOST, mode: 'list' },
		]);
		expect(bad.ok).toBe(true);
		const refused = bad.notices.filter((notice) => notice.code === 'ontology.ddo_self_refused');
		expect(refused.length).toBeGreaterThan(0);
		expect(refused[0]?.details).toMatchObject({
			owner: PORTAL_BAD,
			ddo: TEXT_A,
			parent: PORTAL_NM,
			depth: 2,
		});
		// NM is emitted (depth 1 stands) with the caller's REMAINING child [B] — no A
		expect(tiposAt(bad.items, MID)).toEqual(new Set([PORTAL_NM]));
		expect(tiposAt(bad.items, TARGET)).toEqual(new Set([TEXT_B]));
		// control: the explicit twin (EDIT — its own map, not the section_list) resolves A, no notice
		const good = await readHost('edit', [
			{ tipo: PORTAL_GOOD, section_tipo: HOST, parent: HOST, mode: 'edit' },
		]);
		expect(good.ok).toBe(true);
		expect(good.notices.some((notice) => notice.code === 'ontology.ddo_self_refused')).toBe(false);
		expect(tiposAt(good.items, TARGET).has(TEXT_A)).toBe(true);
		// … and in LIST, GOOD's section_list LBAD is the config: its depth-2 source
		// 'self' is refused alike, owned by GOOD (the list node's parent)
		const goodList = await readHost('list', [
			{ tipo: PORTAL_GOOD, section_tipo: HOST, parent: HOST, mode: 'list' },
		]);
		const listRefused = goodList.notices.filter(
			(notice) => notice.code === 'ontology.ddo_self_refused',
		);
		expect(listRefused[0]?.details).toMatchObject({
			owner: PORTAL_GOOD,
			ddo: TEXT_B,
			parent: PORTAL_NM,
			depth: 2,
		});
	});

	test('the ontology check lists BAD and the section_list LBAD (owner GOOD) — never GOOD itself', async () => {
		const { scanned, findings } = await scanDeepSelfDefinitions([TLD]);
		// every zzmj node with a request_config was read (anti-vacuity)
		expect(scanned).toBeGreaterThanOrEqual(10);
		const located = findings.map((finding) => [
			finding.tipo,
			finding.owner,
			finding.slot,
			finding.ddo,
			finding.parent,
			finding.depth,
		]);
		expect(located).toEqual([
			[PORTAL_BAD, PORTAL_BAD, 'show', TEXT_A, PORTAL_NM, 2],
			[LIST_BAD, PORTAL_GOOD, 'show', TEXT_B, PORTAL_NM, 2],
			[LIST_VR, SECTION_VV, 'show', TEXT_A, PORTAL_NM, 2],
			[LIST_VR, SECTION_VV, 'hide', TEXT_C, PORTAL_NM, 2],
			[LIST_RL, SECTION_RL, 'show', TEXT_A, PORTAL_NM, 2],
		]);
		expect(findings.some((finding) => finding.tipo === PORTAL_GOOD)).toBe(false);
	});

	test('one rule, two consumers: a list node named as PARENT is an orphan for the read AND the check', async () => {
		// The read: LP in list takes LLP; NM's parent is LLP (verbatim, never the
		// owner LP), so the chain is an orphan — kept, no refusal notice.
		const read = await readHost('list', [
			{ tipo: PORTAL_LP, section_tipo: HOST, parent: HOST, mode: 'list' },
		]);
		expect(read.ok).toBe(true);
		expect(read.notices.some((notice) => notice.code === 'ontology.ddo_self_refused')).toBe(false);
		// The check: the same answer — nothing listed for LLP (nor LP).
		const { findings } = await scanDeepSelfDefinitions([TLD]);
		expect(findings.some((finding) => finding.tipo === LIST_LP || finding.tipo === PORTAL_LP)).toBe(
			false,
		);
	});

	test('a section_list the read never swaps in (its SECTION keeps a direct request_config) is not listed', async () => {
		const { findings } = await scanDeepSelfDefinitions([TLD]);
		expect(
			findings.some((finding) => finding.tipo === LIST_KO || finding.tipo === SECTION_KO),
		).toBe(false);
	});

	test("keep-own is the read's ISSET test: a section with a non-array config never swaps its list node in", async () => {
		const { findings } = await scanDeepSelfDefinitions([TLD]);
		expect(
			findings.some((finding) => finding.tipo === LIST_OBJ || finding.tipo === SECTION_OBJ),
		).toBe(false);
	});

	/** A list read of a whole SECTION (no client show: the section's OWN derived column map). */
	const readSectionList = async (sectionTipo: string) => {
		const rqo = {
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'section',
				tipo: sectionTipo,
				section_tipo: sectionTipo,
				action: 'search',
				mode: 'list',
				lang: 'lg-nolan',
			},
			sqo: { section_tipo: [sectionTipo], limit: 1, offset: 0 },
		};
		const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never))
			.body as never as {
			ok?: boolean;
			data?: { context?: ContextEntry[] };
			notices?: { code: string; details?: Record<string, unknown> }[];
		};
		return {
			body,
			refused: (body.notices ?? []).filter((notice) => notice.code === 'ontology.ddo_self_refused'),
		};
	};

	test("a REAL section's own section_list: the read refuses the depth-2 'self' with a response notice owned by the section", async () => {
		const { body, refused } = await readSectionList(SECTION_RL);
		expect(body.ok).not.toBe(false);
		const sectionContext = contextsOf(body.data?.context ?? [], SECTION_RL, SECTION_RL)[0];
		expect(slotOf(sectionContext, 'show')).toEqual([PORTAL_NM]);
		expect(refused.map((notice) => notice.details)).toEqual([
			expect.objectContaining({ owner: SECTION_RL, ddo: TEXT_A, parent: PORTAL_NM, depth: 2 }),
		]);
	});

	test("virtual fallback: a config-less virtual section reads its real section's list node — measured from the VIRTUAL reader by the read AND the check", async () => {
		// The read: a list read of SVV (no config, no list node of its own) takes
		// SVR's section_list LVR although SVR keeps its own config [B] (the
		// keep-own test is SVV's), with SVV as the owner: it skips the 'self'-rooted
		// depth-2 A (show) and the depth-2 C under the chain rooted on the literal
		// SVV (hide), and KEEPS the chain rooted on the literal SVR (search — an
		// orphan for SVV). Each refusal reaches the RESPONSE (decision (c)).
		const { body, refused } = await readSectionList(SECTION_VV);
		expect(body.ok).not.toBe(false);
		const sectionContext = contextsOf(body.data?.context ?? [], SECTION_VV, SECTION_VV)[0];
		// LVR's map (NM), never SVR's own [B]; A skipped
		expect(slotOf(sectionContext, 'show')).toEqual([PORTAL_NM]);
		expect(
			refused
				.map((notice) => [notice.details?.owner, notice.details?.ddo, notice.details?.parent])
				.sort(),
		).toEqual(
			[
				[SECTION_VV, TEXT_A, PORTAL_NM],
				[SECTION_VV, TEXT_C, PORTAL_NM],
			].sort(),
		);
		// The check: the same two, owned by SVV — and nothing for the SVR-rooted search chain.
		const { findings } = await scanDeepSelfDefinitions([TLD]);
		expect(
			findings
				.filter((finding) => finding.tipo === LIST_VR)
				.map((finding) => [finding.slot, finding.owner, finding.ddo, finding.readers]),
		).toEqual([
			['show', SECTION_VV, TEXT_A, [SECTION_VV]],
			['hide', SECTION_VV, TEXT_C, [SECTION_VV]],
		]);
	});

	test("two section_list children: only the FIRST by order_number is read — the second's depth-2 self is listed by nobody", async () => {
		// The read: TL in list takes LTL1 (order 1, compliant: B under NM) — no notice.
		const read = await readHost('list', [
			{ tipo: PORTAL_TL, section_tipo: HOST, parent: HOST, mode: 'list' },
		]);
		expect(read.ok).toBe(true);
		expect(read.notices.some((notice) => notice.code === 'ontology.ddo_self_refused')).toBe(false);
		expect(tiposAt(read.items, TARGET)).toEqual(new Set([TEXT_B]));
		// The check: LTL2 (order 2, a depth-2 'self') is never swapped in — not listed.
		const { findings } = await scanDeepSelfDefinitions([TLD]);
		expect(
			findings.some(
				(finding) =>
					finding.tipo === LIST_TL2 || finding.tipo === LIST_TL1 || finding.tipo === PORTAL_TL,
			),
		).toBe(false);
	});

	test("CLIENT door, component stage 1: a get_data whose own show carries a depth-2 'self' skips it with a notice owned by the portal", async () => {
		// GOOD's ontology map is compliant (A under NM at TARGET); the CLIENT sends
		// its own show with A under NM as a guessed 'self' — stage 1 replaces the
		// show slot, so only the stage-1 refusal stands between it and the read.
		const rqo = {
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				type: 'component',
				action: 'get_data',
				model: 'component_portal',
				tipo: PORTAL_GOOD,
				section_tipo: HOST,
				section_id: HOST_ID,
				mode: 'edit',
				lang: 'lg-nolan',
			},
			sqo: { section_tipo: [MID], limit: 10, offset: 0 },
			show: {
				ddo_map: [
					{ tipo: PORTAL_NM, parent: 'self', section_tipo: 'self', mode: 'list' },
					{ tipo: TEXT_A, parent: PORTAL_NM, section_tipo: 'self', mode: 'list' },
					{ tipo: TEXT_C, parent: PORTAL_NM, section_tipo: TARGET, mode: 'list' },
				],
			},
		};
		const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
			ok?: boolean;
			data?: { data?: Item[]; context?: ContextEntry[] };
			notices?: Notice[];
		};
		expect(body.ok).not.toBe(false);
		const items = (body.data?.data ?? []).filter((item) => item.typo !== 'sections');
		// anti-vacuity: NM (depth 1, 'self' = GOOD's target MID) is read
		expect(tiposAt(items, MID)).toEqual(new Set([PORTAL_NM]));
		// NM keeps the caller's REMAINING child [C] — never A (NM's own [A, B]
		// is not reinstated: caller children were declared)
		expect(tiposAt(items, TARGET)).toEqual(new Set([TEXT_C]));
		expect(
			(body.data?.context ?? []).some(
				(entry) => entry.tipo === TEXT_A && entry.section_tipo === TARGET,
			),
		).toBe(false);
		const refused = (body.notices ?? []).filter(
			(notice) => notice.code === 'ontology.ddo_self_refused',
		);
		expect(refused.map((notice) => notice.details)).toEqual([
			expect.objectContaining({ owner: PORTAL_GOOD, ddo: TEXT_A, parent: PORTAL_NM, depth: 2 }),
		]);
	});

	test("CLIENT door, section stage 1: a section read whose show carries a deep 'self' skips it with a notice owned by the section", async () => {
		const read = await readHost('edit', [
			{ tipo: PORTAL_GOOD, section_tipo: HOST, parent: HOST, mode: 'edit' },
			{ tipo: PORTAL_NM, section_tipo: MID, parent: PORTAL_GOOD, mode: 'list' },
			{ tipo: TEXT_A, section_tipo: 'self', parent: PORTAL_NM, mode: 'list' },
			{ tipo: TEXT_C, section_tipo: TARGET, parent: PORTAL_NM, mode: 'list' },
		]);
		expect(read.ok).toBe(true);
		expect(tiposAt(read.items, MID)).toEqual(new Set([PORTAL_NM]));
		expect(tiposAt(read.items, TARGET)).toEqual(new Set([TEXT_C]));
		const refused = read.notices.filter((notice) => notice.code === 'ontology.ddo_self_refused');
		expect(refused.map((notice) => notice.details)).toEqual([
			expect.objectContaining({ owner: HOST, ddo: TEXT_A, parent: PORTAL_NM, depth: 3 }),
		]);
	});

	test('the registered reconcile reports the same findings dry, and refuses an apply', async () => {
		await registerAllReconciles();
		const { report } = await runReconcile(DDO_SELF_DEPTH, { apply: false, scope: [TLD] });
		expect(report.drift).toBe(5);
		expect(report.applied).toBe(0);
		expect((report.detail.findings as { tipo: string }[]).map((finding) => finding.tipo)).toEqual([
			PORTAL_BAD,
			LIST_BAD,
			LIST_VR,
			LIST_VR,
			LIST_RL,
		]);
		await expect(runReconcile(DDO_SELF_DEPTH, { apply: true, scope: [TLD] })).rejects.toMatchObject(
			{ code: 'request.invalid' },
		);
	});
});

describe('relation_index related_list: an EXPLICIT-config relation child expands its own show (PHP-verified)', () => {
	/** The TARGET tipos emitted after the RPE cell at REF2 (up to the next REF2 item). */
	const rpeChildren = (items: Item[]): Set<unknown> => {
		const index = items.findIndex((item) => item.tipo === PORTAL_RPE && item.section_tipo === REF2);
		expect(index).toBeGreaterThanOrEqual(0);
		const children = new Set<unknown>();
		for (const next of items.slice(index + 1)) {
			if (next.section_tipo === REF2) break;
			if (next.section_tipo === TARGET) children.add(next.tipo);
		}
		return children;
	};

	/**
	 * RPE's own expanded child A keeps PHP's grandchild stamps: built by RPE's
	 * get_subdatum, so from_component_tipo is the PORTAL RPE (class.common.php
	 * :2683-2686) and its mode 'list' (resolve_ddo_mode, a non-section caller)
	 * — only the direct related_list cell RPE carries 'related_list'.
	 */
	const expectGrandchildStamps = (items: Item[]) => {
		const cell = items.find((item) => item.tipo === PORTAL_RPE && item.section_tipo === REF2);
		expect(cell?.mode).toBe('related_list');
		expect(cell?.from_component_tipo).toBe(PORTAL_RPE);
		const grandchild = items.find((item) => item.tipo === TEXT_A && item.section_tipo === TARGET);
		expect(grandchild?.from_component_tipo).toBe(PORTAL_RPE);
		expect(grandchild?.mode).toBe('list');
	};

	test('section door: RPE (related_list) shows its OWN [A] — never its section_list [C]; the literal TR stands', async () => {
		const rqo = {
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				model: 'section',
				tipo: TARGET,
				section_tipo: TARGET,
				action: 'search',
				mode: 'edit',
				lang: 'lg-nolan',
			},
			sqo: {
				section_tipo: [TARGET],
				limit: 1,
				offset: 0,
				filter_by_locators: [{ section_tipo: TARGET, section_id: '1' }],
			},
			show: { ddo_map: [{ tipo: INDEX_RI, section_tipo: TARGET, parent: TARGET, mode: 'edit' }] },
		};
		const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
			ok?: boolean;
			data?: { data?: Item[] };
		};
		expect(body.ok).not.toBe(false);
		const items = body.data?.data ?? [];
		expect(tiposAt(items, REF2)).toEqual(new Set([PORTAL_RPE, TEXT_R]));
		expect(rpeChildren(items)).toEqual(new Set([TEXT_A]));
		expectGrandchildStamps(items);
	});

	test('get_data door: the same expansion on the component read of RI', async () => {
		const rqo = {
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			source: {
				typo: 'source',
				type: 'component',
				action: 'get_data',
				model: 'component_relation_index',
				tipo: INDEX_RI,
				section_tipo: TARGET,
				section_id: 1,
				mode: 'edit',
				lang: 'lg-nolan',
			},
			sqo: { section_tipo: [TARGET], limit: 10, offset: 0 },
		};
		const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
			ok?: boolean;
			data?: { data?: Item[] };
		};
		expect(body.ok).not.toBe(false);
		const items = body.data?.data ?? [];
		expect(tiposAt(items, REF2)).toEqual(new Set([PORTAL_RPE, TEXT_R]));
		expect(rpeChildren(items)).toEqual(new Set([TEXT_A]));
		expectGrandchildStamps(items);
	});
});
