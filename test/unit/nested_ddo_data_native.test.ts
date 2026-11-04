/**
 * NESTED-DDO DATA — the element-node data path end to end on the suite DB
 * (nested-ddo_map plan, W2; relations/element_node.ts resolveElement, the
 * per-emission registry, relations/models/portal.ts + relation_core.ts
 * expandPortal). PHP's `get_subdatum` keeps ONE request_config per element
 * instance, injected in place by its caller; the TS data path now resolves the
 * same node and expands its children from it.
 *
 * Every data case sits ONE LEVEL DOWN — HOST —P1→ MID —NM→ TARGET — because
 * that is where the retired `depth < 4 && (edit || list && ownConfig)` gate
 * applied (a top-level column always took its caller's children, or fell back
 * to its own config, before W2 too). NM's own config shows [A, B].
 *
 *  (a) CALLER CHILDREN REPLACE THE OWN SHOW MAP, edit and list: the caller's
 *      map declares NM's children [B, C] two levels deep → A ABSENT, C
 *      PRESENT, caller order B, C (PHP class.common.php :2629-2678). This
 *      replacement two levels down ALREADY held before W2 (the old path handed
 *      the whole caller map down every level — the numisdata3 fix) and must
 *      keep holding now that the children come from NM's node; the W2-specific
 *      changes are pinned by (b), (e), (f), (g), (h), (i) and the node probes.
 *  (b) OWN-CONFIG FALLBACK IN LIST MODE (plan E2): the caller names NM but none
 *      of its children → NM's own [A, B]. Before W2 the gate refused it.
 *  (c) THE GOVERNING LIMIT at depth 2: a `limit` on the caller's line for NM is
 *      NM's data page (1, 2, all 3 under 10) AND its effective sqo.limit (the
 *      node, probed below — the half the context will read).
 *  (d) A RECORD CYCLE STOPS WITH A NOTICE (owner decision (e)): X1 —PX→ Y1
 *      —PY→ X1 … where each portal's OWN config shows the other portal (no map
 *      repeats, so only the per-path visited guard on (section_tipo,
 *      section_id, tipo) can end it). The read completes, ok, one notice.
 *  (e) A LONG NON-CYCLIC CHAIN STOPS AT MAX_DDO_DEPTH WITH A NOTICE: A1 → B1 →
 *      A2 → … through the two portals' OWN configs (each hop a new record; two
 *      alternating sections, since a portal showing itself is a MAP cycle the
 *      caller-children walk cuts first). The read is ok, A7 (depth 12) still
 *      resolves, B7 (depth 13) does not, and one `relation.depth_bound_stopped`
 *      notice names the cut — never the old whole-read 400
 *      (request.invalid_rqo) for ordinary data.
 *  (f) STAGE 1 on a get_data door: an rqo `show` naming [C] for the TARGETED
 *      portal replaces its own [A, B] (configSource 'rqo').
 *  (g) A LIST get_data resolves the READ's real mode: SL's own show [A] in edit,
 *      its section_list child's [C] in list — the same config the list cell's
 *      context declares (the node used to resolve 'edit' whatever the mode).
 *  (h) A FRAME CHILD expands its OWN children (PHP component_dataframe_json.php
 *      :221 → get_subdatum): H's frame FH shows the portal PT, whose own config
 *      shows C — C at PT's target is emitted, stamped by PT (not re-stamped by
 *      the frame). Before, frame children were one-level and PT expanded nothing.
 *  (i) THE DEPTH BOUND ON A LITERAL'S FRAME (part of (e)): the chain's TEXT_CA
 *      carries a frame (FCA, has_dataframe); at A7 (depth 12) its paired entry
 *      would put FCA's children at depth 13 — stopped with a depth-bound notice
 *      naming FCA, never the whole-read 400. Before, only the portal hop had
 *      the soft stop and this hop reached emitDdoData's request.invalid_rqo.
 *
 *  (j) A MULTI-SECTION read owns every row's cell by the ROW's section (PHP
 *      get_subdatum `$current_locator->section_tipo`): REAL and its VIRTUAL
 *      twin in one sqo, one column map naming the self-targeting portal PS at
 *      REAL; the VIRTUAL row's PS resolves 'self' to VIRTUAL, so its child TS
 *      is emitted at the VIRTUAL target (the ddo's first section stamped it
 *      REAL and the per-locator filter dropped it — a blank cell). List only:
 *      an edit read pages one record.
 *  (k) THE DDINFO TRIGGER (owner decision (g); relation_core expandPortal) on
 *      a component_autocomplete_hi HA → a THESAURUS-TABLE section (matrix_hierarchy,
 *      dd425): (1) a caller child with value_with_parents → ddinfo (pre-W2 it
 *      required the own config); (2) caller children WITHOUT it → NO ddinfo
 *      (the thesaurus-table branch is not widened to injected children);
 *      (3) the own config, no caller → the thesaurus-table branch still fires.
 *  (l) A TOP-LEVEL LITERAL resolves under the read's ROOT map like a top-level
 *      portal: a section map [H, FH<H (mode edit), C<FH] reaches the frame —
 *      FH's children are [C] (the caller's), not its own [PT], and the frame
 *      item takes the caller's mode. And a frame child keeps its WHOLE governing
 *      ddo: PT<FH `limit: 2` pages PT's cell by 2 (C2 and C3).
 *  (c') THE GOVERNING LIMIT vs a SYNTHESISED show.sqo_config: NH's own sqo.limit 3
 *      synthesises show.sqo_config.limit 3 (explicit.ts); a caller line `limit: 2`
 *      lands on sqo.limit only — the sqo_config stays 3, where PHP would
 *      synthesise it from the governing limit (2): deliberate divergence
 *      WC-2026-11-04-governing-limit-sqo-limit-only — and is still the list page
 *      (nodeListPageLimit reads the governing limit first): 2 records.
 *
 * NODE PROBES (resolveElement against the same ontology — the semantics the
 * W3 contexts will serialise): own only (configSource 'own', not injected);
 * per-slot replacement (a hide-only caller keeps the own show, a show-only
 * caller keeps the own hide, a SEARCH-only caller leaves the data children own —
 * dataChildrenInjected false, so the ddinfo / frame / origin consumers still
 * see own children); stage 1 wins over own and caller; the governing
 * limit on sqo.limit; a one-level expansion (useOwnConfig false — related_list
 * / frame children) keeps its OWN page size but none of its own children.
 *
 * W3 CONTEXT (section/node_contexts.ts — the context serialised from the SAME
 * node its data came from), at the section read (edit, list), get_data (stage 1
 * on the target; a nested NM two levels down), resolve_data and the save echo:
 * own [A, B] vs caller [B, C] → the context's show map is [B, C], no A context,
 * C's context present, B before C; the context sqo.limit is the governing limit
 * and the data page; and per occurrence (owner decision (b)): NM under P1
 * (caller [B]) and under P2 (own [A, B]) ship TWO contexts and the NM data
 * items carry the matching `caller_chain`, while identical configs ship ONE
 * entry and stamp nothing.
 *
 * Situation: the scratch TLD `zzni`, built through the engine's own write path
 * (ensureSituation → assertTestDatabase) and dropped after (residue 0).
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import type { Ddo } from '../../src/core/concepts/ddo.ts';
import { recordTimeMachine } from '../../src/core/db/time_machine.ts';
import {
	MAX_DDO_DEPTH,
	nodeListPageLimit,
	resolveElement,
	rootNodeFor,
} from '../../src/core/relations/element_node.ts';
import {
	type ElementNode,
	ElementNodeRegistry,
} from '../../src/core/relations/element_registry.ts';
import { NodeContextSet } from '../../src/core/section/node_contexts.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { countActivityRows, sweepActivityRows } from '../helpers/activity_rows.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

/** The host section and its portal N (own config → TARGET, show [A, B]). */
const HOST = 'zzni1';
const PORTAL_N = 'zzni2';
const TARGET = 'zzni3';
const TEXT_A = 'zzni4';
const TEXT_B = 'zzni5';
const TEXT_C = 'zzni6';
/** The record-cycle pair: X —PX→ Y —PY→ X. */
const CYCLE_X = 'zzni7';
const PORTAL_X = 'zzni8';
const CYCLE_Y = 'zzni9';
const PORTAL_Y = 'zzni10';
const TEXT_Y = 'zzni11';
/** The nested pair: HOST —P1→ MID —NM→ TARGET (NM's own config shows [A, B]). */
const MID = 'zzni12';
const PORTAL_P1 = 'zzni13';
const PORTAL_NM = 'zzni14';
/** A probe-only portal: own show [A], own hide [B], own page size 3. */
const PORTAL_NH = 'zzni15';
/**
 * The non-cyclic chain, alternating two sections so no MAP repeats (a portal
 * whose own config shows ITSELF is a map cycle, cut by the caller-children
 * walk long before any depth bound): A1 —PA→ B1 —PB→ A2 —PA→ B2 … B_k —PB→
 * A_k+1. Hop h (h ≥ 1) is depth h: B_k at 2k-1, A_k+1 at 2k.
 */
const CHAIN_A = 'zzni16';
const PORTAL_CA = 'zzni17';
const TEXT_CB = 'zzni18';
const TEXT_CA = 'zzni19';
const CHAIN_B = 'zzni20';
const PORTAL_CB = 'zzni21';
const CHAIN_RECORDS = 8;
/** (g) A portal whose own show [A] differs from its section_list child's [C]. */
const PORTAL_SL = 'zzni22';
const SECTION_LIST_SL = 'zzni23';
/** (h) A literal H with a frame FH whose own config shows the portal PT (own show [C]). */
const TEXT_H = 'zzni24';
const FRAME_H = 'zzni25';
const PORTAL_T = 'zzni26';
/** (i) The chain literal TEXT_CA's frame (own show [A]). */
const FRAME_CA = 'zzni27';
/** (j) A self-targeting portal PS on REAL (own show [TS], sqo 'self'), and REAL's VIRTUAL twin. */
const REAL_S = 'zzni28';
const PORTAL_S = 'zzni29';
const TEXT_S = 'zzni30';
const VIRTUAL_S = 'zzni31';
/** (k) A thesaurus-TABLE section (matrix_hierarchy) and an autocomplete_hi HA → it (own show [TT]). */
const THES = 'zzni32';
const TEXT_T = 'zzni33';
const PORTAL_HA = 'zzni34';
/** The matrix_table node naming matrix_hierarchy (isThesaurusTarget). */
const MATRIX_HIERARCHY_TABLE = 'dd425';
/** (m) The DIAMOND: a second host portal P2 → MID 1 (own show [NM]) beside P1 → MID 1. */
const PORTAL_P2 = 'zzni35';
/**
 * (n) A section DS whose OWN config declares its columns (no client show): a
 * portal column DP (limit 2) with a nested multi-target child C declared
 * [THES, TARGET], and an autocomplete_hi column DH with a nested
 * value_with_parents child TT.
 */
const DECLARED_S = 'zzni36';
const PORTAL_DP = 'zzni37';
const PORTAL_DH = 'zzni38';
/** (o) A literal L whose OWN map declares its frame FL "mode":"list"; FL's node says properties.mode 'edit'. */
const TEXT_L = 'zzni39';
const FRAME_L = 'zzni40';
/** (p) A translatable target text (the filter_by_list probe) and a portal FB whose own sqo lists it. */
const TEXT_TR = 'zzni41';
const PORTAL_FB = 'zzni42';
/**
 * (q) A DISTINCT-tipo chain C0 —P0→ C1 —P1→ … C12 —P12→ C13 (TEXT_END): a
 * client map can only name each tipo once per ancestor path (the map walk
 * cuts a repeat), so a client chain past MAX_DDO_DEPTH needs this many tipos.
 */
const DEEP_LEVELS = 13;
const DEEP_SECTIONS = Array.from({ length: DEEP_LEVELS + 1 }, (_, k) => `zzni${43 + k}`);
const DEEP_PORTALS = Array.from({ length: DEEP_LEVELS }, (_, k) => `zzni${57 + k}`);
const DEEP_TEXT_END = 'zzni70';
/**
 * (W3 doors) A REFERENCING section REF whose portal RP points at TARGET 1, and
 * a relation_index RI on TARGET with its OWN config over REF: show [RA, RB]
 * (the own-config strategy, relation_index.ts emitOwnConfigIndexData).
 */
const REF = 'zzni71';
const PORTAL_RP = 'zzni72';
const TEXT_RA = 'zzni73';
const TEXT_RB = 'zzni74';
const TEXT_RC = 'zzni75';
const INDEX_RI = 'zzni76';
const REF_IDS = [1, 2] as const;
/**
 * (W3 TM page size) a portal on HOST whose OWN config declares TWO page sizes:
 * sqo.limit 4 and show.sqo_config.limit 2. A list cell pages by the
 * sqo_config one (nodeListPageLimit); the context must say so in sqo.limit.
 */
const PORTAL_PL = 'zzni77';
/**
 * (r) A literal LF whose frame FS has NO caller children and a raw own map that
 * DIFFERS from its built config: own show [A] with no page size, but in LIST
 * mode (the frame's default) the build swaps to its section_list child SLF —
 * show [C], sqo.limit 2. The frame's data must come from the built node (the
 * one its context serialises), never a second raw read of its properties.
 */
const TEXT_LF = 'zzni78';
const FRAME_FS = 'zzni79';
const SECTION_LIST_FS = 'zzni80';
/** (W3 save echo, last-page swap) a TARGET record N does not point at, inserted and removed again. */
const TARGET_EXTRA_ID = 4;
/** (i) The chain record whose TEXT_CA frame entry sits at depth 12. */
const FRAME_AT_DEPTH_ID = 7;
const MID_ID = 1;

const HOST_ID = 1;
const TARGET_IDS = [1, 2, 3] as const;
const X_ID = 1;
const Y_ID = 1;

/** Locators to `ids` of `sectionTipo`, as `tipo` stores them. */
const locators = (tipo: string, sectionTipo: string, ids: readonly number[]) =>
	ids.map((sectionId, index) => ({
		id: index + 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: tipo,
	}));

/** A portal's own request_config: target `section`, show `ddo_map` (+ hide, own page size). */
const ownConfig = (
	section: string,
	ddoMap: Record<string, unknown>[],
	extra: { hide?: Record<string, unknown>[]; limit?: number } = {},
) => ({
	source: {
		request_config: [
			{
				sqo: {
					section_tipo: [{ value: [section], source: 'section' }],
					...(extra.limit !== undefined ? { limit: extra.limit } : {}),
				},
				show: { ddo_map: ddoMap },
				...(extra.hide !== undefined ? { hide: { ddo_map: extra.hide } } : {}),
			},
		],
	},
});

const textValue = (value: string) => [{ id: 1, lang: 'lg-nolan', value }];

/** One dd490 frame entry pairing `main`'s item 1 with `section`/`id`, stored under `frame`. */
const frameEntry = (frame: string, main: string, section: string, id: number) => [
	{
		id: 1,
		type: 'dd490',
		section_id: id,
		section_tipo: section,
		from_component_tipo: frame,
		main_component_tipo: main,
		id_key: 1,
	},
];

const S = situation({
	name: 'nested ddo data',
	tld: 'zzni',
	nodes: [
		{ tipo: HOST, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL_N,
			parent: HOST,
			model: 'component_portal',
			properties: ownConfig(TARGET, [
				{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET },
				{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
			]),
		},
		{ tipo: TARGET, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: TEXT_A, parent: TARGET, model: 'component_input_text', order_number: 1 },
		{ tipo: TEXT_B, parent: TARGET, model: 'component_input_text', order_number: 2 },
		{ tipo: TEXT_C, parent: TARGET, model: 'component_input_text', order_number: 3 },
		{ tipo: CYCLE_X, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL_X,
			parent: CYCLE_X,
			model: 'component_portal',
			properties: ownConfig(CYCLE_Y, [
				{ tipo: TEXT_Y, parent: 'self', section_tipo: CYCLE_Y },
				{ tipo: PORTAL_Y, parent: 'self', section_tipo: CYCLE_Y },
			]),
		},
		{ tipo: CYCLE_Y, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: TEXT_Y, parent: CYCLE_Y, model: 'component_input_text', order_number: 1 },
		{
			tipo: PORTAL_Y,
			parent: CYCLE_Y,
			model: 'component_portal',
			order_number: 2,
			properties: ownConfig(CYCLE_X, [{ tipo: PORTAL_X, parent: 'self', section_tipo: CYCLE_X }]),
		},
		{ tipo: MID, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL_P1,
			parent: HOST,
			model: 'component_portal',
			properties: ownConfig(MID, [{ tipo: PORTAL_NM, parent: 'self', section_tipo: MID }]),
		},
		{
			tipo: PORTAL_NM,
			parent: MID,
			model: 'component_portal',
			properties: ownConfig(TARGET, [
				{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET },
				{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
			]),
		},
		{
			tipo: PORTAL_NH,
			parent: HOST,
			model: 'component_portal',
			properties: ownConfig(TARGET, [{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET }], {
				hide: [{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET }],
				limit: 3,
			}),
		},
		{ tipo: CHAIN_A, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL_CA,
			parent: CHAIN_A,
			model: 'component_portal',
			order_number: 1,
			properties: ownConfig(CHAIN_B, [
				{ tipo: TEXT_CB, parent: 'self', section_tipo: CHAIN_B },
				{ tipo: PORTAL_CB, parent: 'self', section_tipo: CHAIN_B },
			]),
		},
		{
			tipo: TEXT_CA,
			parent: CHAIN_A,
			model: 'component_input_text',
			order_number: 2,
			properties: { has_dataframe: true },
		},
		{
			tipo: FRAME_CA,
			parent: TEXT_CA,
			model: 'component_dataframe',
			properties: ownConfig(TARGET, [{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET }]),
		},
		{
			tipo: PORTAL_SL,
			parent: HOST,
			model: 'component_portal',
			properties: ownConfig(TARGET, [{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET }]),
		},
		{
			tipo: SECTION_LIST_SL,
			parent: PORTAL_SL,
			model: 'section_list',
			properties: ownConfig(TARGET, [{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET }]),
		},
		{
			tipo: TEXT_H,
			parent: HOST,
			model: 'component_input_text',
			properties: { has_dataframe: true },
		},
		{
			tipo: FRAME_H,
			parent: TEXT_H,
			model: 'component_dataframe',
			properties: ownConfig(TARGET, [{ tipo: PORTAL_T, parent: 'self', section_tipo: TARGET }]),
		},
		{
			tipo: PORTAL_T,
			parent: TARGET,
			model: 'component_portal',
			order_number: 4,
			properties: ownConfig(TARGET, [{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET }]),
		},
		{ tipo: CHAIN_B, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL_CB,
			parent: CHAIN_B,
			model: 'component_portal',
			order_number: 1,
			properties: ownConfig(CHAIN_A, [
				{ tipo: TEXT_CA, parent: 'self', section_tipo: CHAIN_A },
				{ tipo: PORTAL_CA, parent: 'self', section_tipo: CHAIN_A },
			]),
		},
		{ tipo: TEXT_CB, parent: CHAIN_B, model: 'component_input_text', order_number: 2 },
		{ tipo: REAL_S, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{
			tipo: PORTAL_S,
			parent: REAL_S,
			model: 'component_portal',
			order_number: 1,
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: { ddo_map: [{ tipo: TEXT_S, parent: 'self', section_tipo: 'self' }] },
						},
					],
				},
			},
		},
		{ tipo: TEXT_S, parent: REAL_S, model: 'component_input_text', order_number: 2 },
		{
			tipo: VIRTUAL_S,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: REAL_S }, { tipo: 'test24' }],
		},
		{
			tipo: THES,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: MATRIX_HIERARCHY_TABLE }],
		},
		{ tipo: TEXT_T, parent: THES, model: 'component_input_text', order_number: 1 },
		{
			tipo: PORTAL_HA,
			parent: HOST,
			model: 'component_autocomplete_hi',
			properties: ownConfig(THES, [{ tipo: TEXT_T, parent: 'self', section_tipo: THES }]),
		},
		{
			tipo: PORTAL_P2,
			parent: HOST,
			model: 'component_portal',
			properties: ownConfig(MID, [{ tipo: PORTAL_NM, parent: 'self', section_tipo: MID }]),
		},
		{
			tipo: DECLARED_S,
			parent: 'test1',
			model: 'section',
			relations: [{ tipo: 'test24' }],
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ source: 'self' }] },
							show: {
								ddo_map: [
									{ tipo: PORTAL_DP, parent: 'self', section_tipo: 'self', limit: 2 },
									{ tipo: TEXT_C, parent: PORTAL_DP, section_tipo: [THES, TARGET] },
									{ tipo: PORTAL_DH, parent: 'self', section_tipo: 'self' },
									{
										tipo: TEXT_T,
										parent: PORTAL_DH,
										section_tipo: THES,
										value_with_parents: true,
									},
								],
							},
						},
					],
				},
			},
		},
		{
			tipo: PORTAL_DP,
			parent: DECLARED_S,
			model: 'component_portal',
			order_number: 1,
			properties: ownConfig(TARGET, [
				{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET },
				{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
			]),
		},
		{
			tipo: PORTAL_DH,
			parent: DECLARED_S,
			model: 'component_autocomplete_hi',
			order_number: 2,
			properties: ownConfig(THES, [{ tipo: TEXT_T, parent: 'self', section_tipo: THES }]),
		},
		{
			tipo: TEXT_L,
			parent: HOST,
			model: 'component_input_text',
			properties: {
				has_dataframe: true,
				...ownConfig(TARGET, [
					{ tipo: FRAME_L, parent: 'self', section_tipo: 'self', mode: 'list' },
				]),
			},
		},
		{
			tipo: FRAME_L,
			parent: TEXT_L,
			model: 'component_dataframe',
			properties: {
				mode: 'edit',
				...ownConfig(TARGET, [{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET }]),
			},
		},
		{
			tipo: TEXT_TR,
			parent: TARGET,
			model: 'component_input_text',
			order_number: 5,
			is_translatable: true,
		},
		{
			tipo: PORTAL_FB,
			parent: HOST,
			model: 'component_portal',
			properties: {
				source: {
					request_config: [
						{
							sqo: {
								section_tipo: [{ value: [TARGET], source: 'section' }],
								filter_by_list: [{ section_tipo: TARGET, component_tipo: TEXT_TR }],
							},
							show: { ddo_map: [{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET }] },
						},
					],
				},
			},
		},
		{
			tipo: PORTAL_PL,
			parent: HOST,
			model: 'component_portal',
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [TARGET], source: 'section' }], limit: 4 },
							show: {
								ddo_map: [{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET }],
								sqo_config: { limit: 2 },
							},
						},
					],
				},
			},
		},
		{
			tipo: TEXT_LF,
			parent: HOST,
			model: 'component_input_text',
			properties: { has_dataframe: true },
		},
		{
			tipo: FRAME_FS,
			parent: TEXT_LF,
			model: 'component_dataframe',
			properties: ownConfig(TARGET, [{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET }]),
		},
		{
			tipo: SECTION_LIST_FS,
			parent: FRAME_FS,
			model: 'section_list',
			properties: ownConfig(TARGET, [{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET }], {
				limit: 2,
			}),
		},
		{ tipo: REF, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: PORTAL_RP, parent: REF, model: 'component_portal', order_number: 1 },
		{ tipo: TEXT_RA, parent: REF, model: 'component_input_text', order_number: 2 },
		{ tipo: TEXT_RB, parent: REF, model: 'component_input_text', order_number: 3 },
		{ tipo: TEXT_RC, parent: REF, model: 'component_input_text', order_number: 4 },
		{
			tipo: INDEX_RI,
			parent: TARGET,
			model: 'component_relation_index',
			order_number: 6,
			properties: {
				config_relation: { relation_type: 'dd151' },
				...ownConfig(REF, [
					{ tipo: TEXT_RA, parent: 'self', section_tipo: REF },
					{ tipo: TEXT_RB, parent: 'self', section_tipo: REF },
				]),
			},
		},
		...DEEP_SECTIONS.flatMap((section, k) => {
			const sectionNode = {
				tipo: section,
				parent: 'test1',
				model: 'section',
				relations: [{ tipo: 'test24' }],
			};
			if (k === DEEP_LEVELS) {
				return [
					sectionNode,
					{ tipo: DEEP_TEXT_END, parent: section, model: 'component_input_text', order_number: 1 },
				];
			}
			const next = DEEP_SECTIONS[k + 1] as string;
			const nextChild = k + 1 === DEEP_LEVELS ? DEEP_TEXT_END : (DEEP_PORTALS[k + 1] as string);
			return [
				sectionNode,
				{
					tipo: DEEP_PORTALS[k] as string,
					parent: section,
					model: 'component_portal',
					order_number: 1,
					properties: ownConfig(next, [{ tipo: nextChild, parent: 'self', section_tipo: next }]),
				},
			];
		}),
	],
	records: [
		{
			section_tipo: HOST,
			section_id: HOST_ID,
			columns: {
				string: {
					[TEXT_H]: textValue('H1'),
					[TEXT_L]: textValue('L1'),
					[TEXT_LF]: textValue('LF1'),
				},
				relation: {
					[PORTAL_N]: locators(PORTAL_N, TARGET, TARGET_IDS),
					[PORTAL_P1]: locators(PORTAL_P1, MID, [MID_ID]),
					[PORTAL_P2]: locators(PORTAL_P2, MID, [MID_ID]),
					[FRAME_L]: frameEntry(FRAME_L, TEXT_L, TARGET, 1),
					[PORTAL_SL]: locators(PORTAL_SL, TARGET, TARGET_IDS),
					[FRAME_H]: frameEntry(FRAME_H, TEXT_H, TARGET, 1),
					// (r): THREE entries paired with LF's item 1 — the page decides how many emit.
					[FRAME_FS]: TARGET_IDS.map((id, index) => ({
						...frameEntry(FRAME_FS, TEXT_LF, TARGET, id)[0],
						id: index + 1,
					})),
					[PORTAL_NH]: locators(PORTAL_NH, TARGET, TARGET_IDS),
					[PORTAL_HA]: locators(PORTAL_HA, THES, [1]),
				},
			},
		},
		{
			section_tipo: MID,
			section_id: MID_ID,
			columns: { relation: { [PORTAL_NM]: locators(PORTAL_NM, TARGET, TARGET_IDS) } },
		},
		...Array.from({ length: CHAIN_RECORDS }, (_, index) => {
			const id = index + 1;
			return [
				{
					section_tipo: CHAIN_A,
					section_id: id,
					columns: {
						string: { [TEXT_CA]: textValue(`A${id}`) },
						relation: {
							[PORTAL_CA]: locators(PORTAL_CA, CHAIN_B, [id]),
							// (i): only the record at depth 12 pairs a frame entry.
							...(id === FRAME_AT_DEPTH_ID
								? { [FRAME_CA]: frameEntry(FRAME_CA, TEXT_CA, TARGET, 1) }
								: {}),
						},
					},
				},
				{
					section_tipo: CHAIN_B,
					section_id: id,
					columns: {
						string: { [TEXT_CB]: textValue(`B${id}`) },
						...(id < CHAIN_RECORDS
							? { relation: { [PORTAL_CB]: locators(PORTAL_CB, CHAIN_A, [id + 1]) } }
							: {}),
					},
				},
			];
		}).flat(),
		// (W3 doors): REF records pointing at TARGET 1 (what RI indexes), and a
		// TARGET record N does not point at (the last-page swap inserts it).
		...REF_IDS.map((id) => ({
			section_tipo: REF,
			section_id: id,
			columns: {
				string: {
					[TEXT_RA]: textValue(`RA${id}`),
					[TEXT_RB]: textValue(`RB${id}`),
					[TEXT_RC]: textValue(`RC${id}`),
				},
				relation: { [PORTAL_RP]: locators(PORTAL_RP, TARGET, [1]) },
			},
		})),
		{
			section_tipo: TARGET,
			section_id: TARGET_EXTRA_ID,
			columns: {
				string: {
					[TEXT_A]: textValue(`A${TARGET_EXTRA_ID}`),
					[TEXT_B]: textValue(`B${TARGET_EXTRA_ID}`),
					[TEXT_C]: textValue(`C${TARGET_EXTRA_ID}`),
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
				// (h): TARGET 1's PT points at TARGETs 2, 3 (reached only through FH).
				...(id === 1 ? { relation: { [PORTAL_T]: locators(PORTAL_T, TARGET, [2, 3]) } } : {}),
			},
		})),
		// (j): one record per section, each PS pointing at its OWN section's record 2.
		...[REAL_S, VIRTUAL_S].flatMap((section) => [
			{
				section_tipo: section,
				section_id: 1,
				columns: { relation: { [PORTAL_S]: locators(PORTAL_S, section, [2]) } },
			},
			{
				section_tipo: section,
				section_id: 2,
				columns: { string: { [TEXT_S]: textValue(`${section}-2`) } },
			},
		]),
		// (n): the declared-columns record — DP to every target, DH to the thesaurus record.
		{
			section_tipo: DECLARED_S,
			section_id: 1,
			columns: {
				relation: {
					[PORTAL_DP]: locators(PORTAL_DP, TARGET, TARGET_IDS),
					[PORTAL_DH]: locators(PORTAL_DH, THES, [1]),
				},
			},
		},
		// (q): one record per chain level, each Pk → C(k+1) record 1.
		...DEEP_SECTIONS.map((section, k) =>
			k === DEEP_LEVELS
				? {
						section_tipo: section,
						section_id: 1,
						columns: { string: { [DEEP_TEXT_END]: textValue('END') } },
					}
				: {
						section_tipo: section,
						section_id: 1,
						columns: {
							relation: {
								[DEEP_PORTALS[k] as string]: locators(
									DEEP_PORTALS[k] as string,
									DEEP_SECTIONS[k + 1] as string,
									[1],
								),
							},
						},
					},
		),
		// (k): one thesaurus-table record.
		{
			section_tipo: THES,
			section_id: 1,
			columns: { string: { [TEXT_T]: textValue('T1') } },
		},
		{
			section_tipo: CYCLE_X,
			section_id: X_ID,
			columns: { relation: { [PORTAL_X]: locators(PORTAL_X, CYCLE_Y, [Y_ID]) } },
		},
		{
			section_tipo: CYCLE_Y,
			section_id: Y_ID,
			columns: {
				string: { [TEXT_Y]: textValue('Y1') },
				relation: { [PORTAL_Y]: locators(PORTAL_Y, CYCLE_X, [X_ID]) },
			},
		},
	],
});

let tsContext: Record<string, unknown>;
let rootPrincipal: Principal;

beforeAll(async () => {
	await ensureSituation(S);
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	tsContext = {
		requestId: 'nested-ddo-data',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	};
	rootPrincipal = tsContext.principal as Principal;
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

interface Item {
	typo?: unknown;
	tipo?: unknown;
	section_tipo?: unknown;
	section_id?: unknown;
	from_component_tipo?: unknown;
	entries?: unknown;
}

/** One structure-context entry (the fields the W3 gates read). */
interface ContextEntry {
	tipo?: unknown;
	section_tipo?: unknown;
	mode?: unknown;
	caller_chain?: string;
	request_config?: {
		show?: { ddo_map?: { tipo: string }[] } | null;
		sqo?: { limit?: unknown };
	}[];
}

interface Notice {
	code?: string;
	details?: Record<string, unknown>;
}

/** A section read of `section` record `sectionId` through the real pipeline. */
async function readSection(
	section: string,
	sectionId: number,
	mode: 'list' | 'edit',
	ddoMap: Record<string, unknown>[] | null,
	alsoRecords: { section_tipo: string; section_id: number }[] = [],
): Promise<{
	ok: boolean;
	items: Item[];
	context: ContextEntry[];
	notices: Notice[];
	errorCode: string | null;
}> {
	const records = [{ section_tipo: section, section_id: sectionId }, ...alsoRecords];
	const rqo: Record<string, unknown> = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			model: 'section',
			tipo: section,
			section_tipo: section,
			action: 'search',
			mode,
			lang: 'lg-nolan',
		},
		sqo: {
			section_tipo: [...new Set(records.map((record) => record.section_tipo))],
			limit: records.length,
			offset: 0,
			filter_by_locators: records.map((record) => ({
				section_tipo: record.section_tipo,
				section_id: String(record.section_id),
			})),
		},
	};
	if (ddoMap !== null) rqo.show = { ddo_map: ddoMap };
	const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
		ok?: boolean;
		data?: { data?: Item[]; context?: ContextEntry[] };
		notices?: Notice[];
		error?: { code?: string };
	};
	return {
		ok: body.ok !== false,
		items: (body.data?.data ?? []).filter((item) => item.typo !== 'sections'),
		context: body.data?.context ?? [],
		notices: body.notices ?? [],
		errorCode: body.error?.code ?? null,
	};
}

/** Items of `tipo` emitted for the TARGET records. */
const targetItems = (items: Item[], tipo: string): Item[] =>
	items.filter((item) => item.tipo === tipo && item.section_tipo === TARGET);

/** First emission index of `tipo` at a TARGET record (−1 when absent). */
const firstIndex = (items: Item[], tipo: string): number =>
	items.findIndex((item) => item.tipo === tipo && item.section_tipo === TARGET);

/** The caller map: P1 under the host, NM under P1 (with `nmOverrides`), and NM's `children`. */
const nestedMap = (
	mode: 'list' | 'edit',
	nmOverrides: Record<string, unknown>,
	children: string[],
): Record<string, unknown>[] => [
	{ tipo: PORTAL_P1, section_tipo: HOST, parent: HOST, mode },
	{ tipo: PORTAL_NM, section_tipo: MID, parent: PORTAL_P1, mode: 'list', ...nmOverrides },
	...children.map((tipo) => ({ tipo, section_tipo: TARGET, parent: PORTAL_NM, mode: 'list' })),
];

/** A component get_data of the TOP-level portal N on the host record, optionally with a show. */
function getDataN(
	show: Record<string, unknown>[] | null,
): Promise<{ ok: boolean; items: Item[]; context: ContextEntry[]; errorCode: string | null }> {
	return getDataOf(PORTAL_N, 'edit', show);
}

/** A component get_data of the host portal `tipo` in `mode`, optionally with a show. */
async function getDataOf(
	tipo: string,
	mode: 'list' | 'edit',
	show: Record<string, unknown>[] | null,
): Promise<{ ok: boolean; items: Item[]; context: ContextEntry[]; errorCode: string | null }> {
	const rqo: Record<string, unknown> = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			action: 'get_data',
			model: 'component_portal',
			tipo,
			section_tipo: HOST,
			section_id: HOST_ID,
			mode,
			lang: 'lg-nolan',
		},
		sqo: {
			section_tipo: [TARGET],
			limit: 10,
			offset: 0,
			filter_by_locators: [{ section_tipo: HOST, section_id: HOST_ID }],
		},
	};
	if (show !== null) rqo.show = { ddo_map: show };
	const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
		ok?: boolean;
		data?: { data?: Item[]; context?: ContextEntry[] };
		error?: { code?: string };
	};
	return {
		ok: body.ok !== false,
		items: body.data?.data ?? [],
		context: body.data?.context ?? [],
		errorCode: body.error?.code ?? null,
	};
}

/** A fabricated PARENT node whose effective config is exactly `item` (one dedalo main). */
function parentWith(item: Record<string, unknown>): ElementNode {
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
		effectiveConfig: [{ api_engine: 'dedalo', type: 'main', ...item }] as never,
		configSource: 'root',
		injected: false,
		injectedSlots: [],
		dataChildrenInjected: false,
		oneLevel: false,
		childOrigin: 'ontology',
		children: [],
	};
}

/** resolveElement of `tipo` on the host against the real zzni ontology. */
function resolveOnHost(
	tipo: string,
	parentNode: ElementNode | null,
	extra: { ddo?: Record<string, unknown>; useOwnConfig?: boolean; rqo?: unknown } = {},
): Promise<ElementNode> {
	return resolveElement({
		ddo: { tipo, section_tipo: HOST, parent: HOST, ...extra.ddo } as unknown as Ddo,
		parentNode,
		ownerSectionTipo: HOST,
		ownerSectionId: HOST_ID,
		mode: 'list',
		lang: 'lg-nolan',
		registry: new ElementNodeRegistry(),
		model: 'component_portal',
		...(extra.useOwnConfig !== undefined ? { useOwnConfig: extra.useOwnConfig } : {}),
		...(extra.rqo !== undefined ? { rqo: extra.rqo, principal: rootPrincipal } : {}),
	});
}

/** A config item's two page sizes (sqo + show.sqo_config). */
interface PagedItem {
	sqo?: { limit?: unknown };
	show?: { sqo_config?: { limit?: unknown } } | null;
}

/** The tipos of one slot of a node's local (first dedalo) item. */
const slotTipos = (node: ElementNode, slot: 'show' | 'hide'): unknown[] =>
	(
		((node.effectiveConfig[0] as Record<string, { ddo_map?: { tipo: string }[] } | null>)[slot]
			?.ddo_map ?? []) as { tipo: string }[]
	).map((ddo) => ddo.tipo);

describe('nested ddo data (element nodes)', () => {
	for (const mode of ['edit', 'list'] as const) {
		test(`(a) ${mode}: caller children [B, C] two levels deep replace NM's own [A, B], in caller order`, async () => {
			const { ok, items, errorCode } = await readSection(
				HOST,
				HOST_ID,
				mode,
				nestedMap(mode, {}, [TEXT_B, TEXT_C]),
			);
			expect(errorCode).toBeNull();
			expect(ok).toBe(true);
			expect(items.find((item) => item.tipo === PORTAL_NM)).toBeDefined();
			expect(targetItems(items, TEXT_A)).toHaveLength(0);
			const bItems = targetItems(items, TEXT_B);
			const cItems = targetItems(items, TEXT_C);
			expect(bItems.length).toBeGreaterThan(0);
			expect(cItems.length).toBeGreaterThan(0);
			expect(cItems.every((item) => item.from_component_tipo === PORTAL_NM)).toBe(true);
			expect(firstIndex(items, TEXT_B)).toBeLessThan(firstIndex(items, TEXT_C));
		});
	}

	test('(b) list: a caller naming NM but none of its children leaves its own [A, B]', async () => {
		const { ok, items } = await readSection(HOST, HOST_ID, 'list', nestedMap('list', {}, []));
		expect(ok).toBe(true);
		const aItems = targetItems(items, TEXT_A);
		expect(aItems.length).toBeGreaterThan(0);
		expect(aItems[0]?.entries).toEqual(textValue('A1'));
		expect(targetItems(items, TEXT_B).length).toBeGreaterThan(0);
		expect(targetItems(items, TEXT_C)).toHaveLength(0);
		expect(firstIndex(items, TEXT_A)).toBeLessThan(firstIndex(items, TEXT_B));
	});

	for (const mode of ['edit', 'list'] as const) {
		test(`(c) ${mode}: the governing ddo limit at depth 2 is NM's data page`, async () => {
			// Below, at and above the record count — neither NM's own page nor the
			// list cell's default (1) is what decides it.
			const pageOf = async (limit: number): Promise<Set<unknown>> => {
				const read = await readSection(HOST, HOST_ID, mode, nestedMap(mode, { limit }, [TEXT_B]));
				expect(read.ok).toBe(true);
				return new Set(targetItems(read.items, TEXT_B).map((item) => item.section_id));
			};
			expect((await pageOf(1)).size).toBe(1);
			expect((await pageOf(2)).size).toBe(2);
			expect((await pageOf(10)).size).toBe(TARGET_IDS.length);
		});
	}

	test('(c) node: the governing limit is the effective sqo.limit (what the context reads)', async () => {
		const registry = new ElementNodeRegistry();
		const map = nestedMap('list', { limit: 2 }, [TEXT_B]) as unknown as Ddo[];
		const root = rootNodeFor(registry, HOST, HOST, 'list', map);
		const p1 = await resolveElement({
			ddo: map[0] as Ddo,
			parentNode: root,
			ownerSectionTipo: HOST,
			ownerSectionId: HOST_ID,
			mode: 'list',
			lang: 'lg-nolan',
			registry,
			model: 'component_portal',
		});
		const nm = await resolveElement({
			ddo: map[1] as Ddo,
			parentNode: p1,
			ownerSectionTipo: MID,
			ownerSectionId: MID_ID,
			mode: 'list',
			lang: 'lg-nolan',
			registry,
			model: 'component_portal',
		});
		expect(nm.limit).toBe(2);
		expect((nm.effectiveConfig[0]?.sqo as { limit?: unknown } | undefined)?.limit).toBe(2);
		expect(nodeListPageLimit(nm)).toBe(2);
		expect(nm.children.map((child) => child.tipo)).toEqual([TEXT_B]);
	});

	test("(c') node: the governing limit lands on sqo.limit only; the own synthesised sqo_config stays", async () => {
		// NH's own sqo.limit 3 synthesises show.sqo_config.limit 3 (explicit.ts).
		const own = await resolveOnHost(PORTAL_NH, null);
		const ownItem = own.effectiveConfig[0] as unknown as PagedItem;
		expect(ownItem.show?.sqo_config?.limit).toBe(3);
		expect(nodeListPageLimit(own)).toBe(3);

		const governed = await resolveOnHost(PORTAL_NH, null, { ddo: { limit: 2 } });
		const item = governed.effectiveConfig[0] as unknown as PagedItem;
		expect(governed.limit).toBe(2);
		expect(item.sqo?.limit).toBe(2);
		// The (own-limit synthesised) show.sqo_config keeps the own 3; PHP would
		// synthesise it from the governing 2 —
		// WC-2026-11-04-governing-limit-sqo-limit-only.
		expect(item.show?.sqo_config?.limit).toBe(3);
		// … and the page still follows the governing limit (read first).
		expect(nodeListPageLimit(governed)).toBe(2);
	});

	test('(d) a record cycle stops at the repeat with a typed notice', async () => {
		const { ok, items, notices, errorCode } = await readSection(CYCLE_X, X_ID, 'list', [
			{ tipo: PORTAL_X, section_tipo: CYCLE_X, parent: CYCLE_X, mode: 'list' },
		]);
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		// The rest of the read completed: Y1's text and Y1's portal back to X.
		expect(items.find((item) => item.tipo === TEXT_Y)?.entries).toEqual(textValue('Y1'));
		expect(items.some((item) => item.tipo === PORTAL_Y)).toBe(true);
		const cycle = notices.filter((notice) => notice.code === 'relation.record_cycle_stopped');
		expect(cycle).toHaveLength(1);
		expect(cycle[0]?.details).toMatchObject({
			tipo: PORTAL_X,
			section_tipo: CYCLE_X,
			section_id: String(X_ID),
		});
	}, 30000);

	test('(e) a non-cyclic own-config chain stops at MAX_DDO_DEPTH with a notice, the read completes', async () => {
		// The chain reaches past the bound: A8 sits at depth 2 * 7 = 14.
		expect(2 * (CHAIN_RECORDS - 1)).toBeGreaterThan(MAX_DDO_DEPTH + 1);
		const { ok, items, notices, errorCode } = await readSection(CHAIN_A, 1, 'list', [
			{ tipo: PORTAL_CA, section_tipo: CHAIN_A, parent: CHAIN_A, mode: 'list' },
		]);
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		const textAt = (section: string, tipo: string, id: number) =>
			items.find(
				(item) => item.tipo === tipo && item.section_tipo === section && item.section_id === id,
			);
		// MAX_DDO_DEPTH = 12 = A7 (hop 12) still resolves; B7 (hop 13) is past the cut.
		const lastA = MAX_DDO_DEPTH / 2 + 1;
		expect(textAt(CHAIN_B, TEXT_CB, 1)?.entries).toEqual(textValue('B1'));
		expect(textAt(CHAIN_A, TEXT_CA, lastA)?.entries).toEqual(textValue(`A${lastA}`));
		expect(textAt(CHAIN_B, TEXT_CB, lastA)).toBeUndefined();
		const cut = notices.filter((notice) => notice.code === 'relation.depth_bound_stopped');
		const portalCut = cut.filter((notice) => notice.details?.tipo === PORTAL_CA);
		expect(portalCut).toHaveLength(1);
		expect(portalCut[0]?.details).toMatchObject({
			tipo: PORTAL_CA,
			section_tipo: CHAIN_A,
			section_id: String(lastA),
			depth: MAX_DDO_DEPTH,
		});
		// (i) the literal's frame at the same depth: its paired entry's children
		// would sit at depth 13 — stopped with its own notice, the frame item
		// itself still emitted.
		expect(lastA).toBe(FRAME_AT_DEPTH_ID);
		const frameCut = cut.filter((notice) => notice.details?.tipo === FRAME_CA);
		expect(frameCut).toHaveLength(1);
		expect(frameCut[0]?.details).toMatchObject({
			section_tipo: CHAIN_A,
			section_id: String(FRAME_AT_DEPTH_ID),
			depth: MAX_DDO_DEPTH,
		});
		expect(
			items.some(
				(item) =>
					item.tipo === FRAME_CA &&
					item.section_tipo === CHAIN_A &&
					item.section_id === FRAME_AT_DEPTH_ID,
			),
		).toBe(true);
		expect(cut).toHaveLength(2);
	}, 60000);

	test("(f) stage 1: a get_data show naming [C] replaces the targeted portal's own [A, B]", async () => {
		const own = await getDataN(null);
		expect(own.ok).toBe(true);
		expect(targetItems(own.items, TEXT_A).length).toBeGreaterThan(0);
		expect(targetItems(own.items, TEXT_C)).toHaveLength(0);

		const staged = await getDataN([{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET }]);
		expect(staged.errorCode).toBeNull();
		expect(staged.ok).toBe(true);
		expect(targetItems(staged.items, TEXT_C).length).toBe(TARGET_IDS.length);
		expect(targetItems(staged.items, TEXT_A)).toHaveLength(0);
		expect(targetItems(staged.items, TEXT_B)).toHaveLength(0);
	});

	test('(g) a list get_data resolves its section_list config; edit keeps the own show', async () => {
		const edit = await getDataOf(PORTAL_SL, 'edit', null);
		expect(edit.errorCode).toBeNull();
		expect(targetItems(edit.items, TEXT_A).length).toBeGreaterThan(0);
		expect(targetItems(edit.items, TEXT_C)).toHaveLength(0);

		const list = await getDataOf(PORTAL_SL, 'list', null);
		expect(list.errorCode).toBeNull();
		expect(list.ok).toBe(true);
		expect(targetItems(list.items, TEXT_C).length).toBeGreaterThan(0);
		expect(targetItems(list.items, TEXT_A)).toHaveLength(0);
	});

	test('(h) a frame child portal expands its OWN children (not one-level)', async () => {
		const { ok, items, errorCode } = await readSection(HOST, HOST_ID, 'edit', [
			{ tipo: TEXT_H, section_tipo: HOST, parent: HOST, mode: 'edit' },
		]);
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		// The frame item and its child portal at the paired target (TARGET 1).
		expect(items.some((item) => item.tipo === FRAME_H)).toBe(true);
		const portal = items.find((item) => item.tipo === PORTAL_T);
		expect(portal).toBeDefined();
		expect(portal?.from_component_tipo).toBe(FRAME_H);
		// PT's OWN child C at PT's own target (TARGET 2) — identity kept, not
		// re-stamped onto the frame's target.
		const grandchild = items.find(
			(item) => item.tipo === TEXT_C && item.section_tipo === TARGET && item.section_id === 2,
		);
		expect(grandchild?.entries).toEqual(textValue('C2'));
		expect(grandchild?.from_component_tipo).toBe(PORTAL_T);
	});

	// LIST only: an edit read pages ONE record, so it is never multi-section.
	test("(j) list: a multi-section read owns each row's cell by the row's section", async () => {
		const mode = 'list';
		const { ok, items, errorCode } = await readSection(
			REAL_S,
			1,
			mode,
			[{ tipo: PORTAL_S, section_tipo: REAL_S, parent: REAL_S, mode }],
			[{ section_tipo: VIRTUAL_S, section_id: 1 }],
		);
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		const childAt = (section: string) =>
			items.find(
				(item) => item.tipo === TEXT_S && item.section_tipo === section && item.section_id === 2,
			);
		expect(childAt(REAL_S)?.entries).toEqual(textValue(`${REAL_S}-2`));
		// The VIRTUAL row's cell: its 'self' is VIRTUAL, never the column's REAL.
		expect(childAt(VIRTUAL_S)?.entries).toEqual(textValue(`${VIRTUAL_S}-2`));
		expect(childAt(VIRTUAL_S)?.from_component_tipo).toBe(PORTAL_S);
	});

	describe('(k) the ddinfo trigger on a thesaurus-table target', () => {
		const ddinfoItems = (items: Item[]) =>
			items.filter((item) => item.tipo === 'ddinfo' && item.section_tipo === THES);
		const haLine = { tipo: PORTAL_HA, section_tipo: HOST, parent: HOST, mode: 'edit' };

		test('(1) a caller child with value_with_parents emits ddinfo', async () => {
			const { ok, items, errorCode } = await readSection(HOST, HOST_ID, 'edit', [
				haLine,
				{
					tipo: TEXT_T,
					section_tipo: THES,
					parent: PORTAL_HA,
					mode: 'list',
					value_with_parents: true,
				},
			]);
			expect(errorCode).toBeNull();
			expect(ok).toBe(true);
			expect(items.some((item) => item.tipo === TEXT_T && item.section_tipo === THES)).toBe(true);
			expect(ddinfoItems(items)).toHaveLength(1);
		});

		test('(2) caller children WITHOUT value_with_parents: no ddinfo (branch not widened)', async () => {
			const { ok, items } = await readSection(HOST, HOST_ID, 'edit', [
				haLine,
				{ tipo: TEXT_T, section_tipo: THES, parent: PORTAL_HA, mode: 'list' },
			]);
			expect(ok).toBe(true);
			expect(items.some((item) => item.tipo === TEXT_T && item.section_tipo === THES)).toBe(true);
			expect(ddinfoItems(items)).toHaveLength(0);
		});

		test('(3) the own config, no caller children: the thesaurus-table branch fires', async () => {
			const { ok, items } = await readSection(HOST, HOST_ID, 'edit', [haLine]);
			expect(ok).toBe(true);
			expect(items.some((item) => item.tipo === TEXT_T && item.section_tipo === THES)).toBe(true);
			expect(ddinfoItems(items)).toHaveLength(1);
		});
	});

	test('(l) a top-level literal resolves under the root map: the caller reaches its frame', async () => {
		const { ok, items, errorCode } = await readSection(HOST, HOST_ID, 'edit', [
			{ tipo: TEXT_H, section_tipo: HOST, parent: HOST, mode: 'edit' },
			{ tipo: FRAME_H, section_tipo: HOST, parent: TEXT_H, mode: 'edit' },
			{ tipo: TEXT_C, section_tipo: TARGET, parent: FRAME_H, mode: 'list' },
		]);
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		const frame = items.find((item) => item.tipo === FRAME_H) as Item & { mode?: unknown };
		expect(frame).toBeDefined();
		// The caller's line governs the frame (its declared mode) …
		expect(frame.mode).toBe('edit');
		// … and its children: [C] at the paired TARGET 1, not the own [PT].
		const c1 = items.find(
			(item) => item.tipo === TEXT_C && item.section_tipo === TARGET && item.section_id === 1,
		);
		expect(c1?.entries).toEqual(textValue('C1'));
		expect(c1?.from_component_tipo).toBe(FRAME_H);
		expect(items.some((item) => item.tipo === PORTAL_T)).toBe(false);
	});

	test("(l) a frame child keeps its whole governing ddo: the caller's limit pages it", async () => {
		const pageOf = async (line: Record<string, unknown>): Promise<unknown[]> => {
			const { ok, items, errorCode } = await readSection(HOST, HOST_ID, 'edit', [
				{ tipo: TEXT_H, section_tipo: HOST, parent: HOST, mode: 'edit' },
				{ tipo: FRAME_H, section_tipo: HOST, parent: TEXT_H, mode: 'edit' },
				{ tipo: PORTAL_T, section_tipo: TARGET, parent: FRAME_H, mode: 'list', ...line },
				{ tipo: TEXT_C, section_tipo: TARGET, parent: PORTAL_T, mode: 'list' },
			]);
			expect(errorCode).toBeNull();
			expect(ok).toBe(true);
			return items
				.filter(
					(item) =>
						item.tipo === TEXT_C &&
						item.section_tipo === TARGET &&
						item.from_component_tipo === PORTAL_T,
				)
				.map((item) => item.section_id)
				.sort();
		};
		expect(await pageOf({ limit: 2 })).toEqual([2, 3]);
		expect(await pageOf({ limit: 1 })).toEqual([2]);
	});

	test("(c') list: a governing limit below a declared sqo_config page is the list page", async () => {
		const pageOf = async (line: Record<string, unknown>): Promise<Set<unknown>> => {
			const { ok, items } = await readSection(HOST, HOST_ID, 'list', [
				{ tipo: PORTAL_NH, section_tipo: HOST, parent: HOST, mode: 'list', ...line },
			]);
			expect(ok).toBe(true);
			return new Set(
				targetItems(items, TEXT_A)
					.filter((item) => item.from_component_tipo === PORTAL_NH)
					.map((item) => item.section_id),
			);
		};
		// Own page 3 (all three) without a governing line; 2 under one.
		expect((await pageOf({})).size).toBe(TARGET_IDS.length);
		expect((await pageOf({ limit: 2 })).size).toBe(2);
	});
});

describe('element node probes (resolveElement on the zzni ontology)', () => {
	test('own only: no parent → the own config, not injected', async () => {
		const node = await resolveOnHost(PORTAL_NH, null);
		expect(node.configSource).toBe('own');
		expect(node.injected).toBe(false);
		expect(slotTipos(node, 'show')).toEqual([TEXT_A]);
		expect(slotTipos(node, 'hide')).toEqual([TEXT_B]);
		expect(node.children.map((child) => child.tipo)).toEqual([TEXT_A, TEXT_B]);
	});

	test('per slot: a hide-only caller keeps the own show (plan E3)', async () => {
		const parent = parentWith({
			show: { ddo_map: [{ tipo: PORTAL_NH, parent: 'self', section_tipo: HOST }] },
			hide: { ddo_map: [{ tipo: TEXT_C, parent: PORTAL_NH, section_tipo: TARGET }] },
		});
		const node = await resolveOnHost(PORTAL_NH, parent);
		expect(node.configSource).toBe('own');
		expect(node.injected).toBe(true);
		expect(node.injectedSlots).toEqual(['hide']);
		expect(node.dataChildrenInjected).toBe(true);
		expect(slotTipos(node, 'show')).toEqual([TEXT_A]);
		expect(slotTipos(node, 'hide')).toEqual([TEXT_C]);
	});

	test('per slot: a show-only caller keeps the own hide', async () => {
		const parent = parentWith({
			show: {
				ddo_map: [
					{ tipo: PORTAL_NH, parent: 'self', section_tipo: HOST },
					{ tipo: TEXT_C, parent: PORTAL_NH, section_tipo: TARGET },
				],
			},
		});
		const node = await resolveOnHost(PORTAL_NH, parent);
		expect(node.injected).toBe(true);
		expect(slotTipos(node, 'show')).toEqual([TEXT_C]);
		expect(slotTipos(node, 'hide')).toEqual([TEXT_B]);
		expect(node.children.map((child) => child.tipo)).toEqual([TEXT_C, TEXT_B]);
		// The own sqo (target + page size) stands under any injection.
		expect(nodeListPageLimit(node)).toBe(3);
	});

	test('per slot: a SEARCH-only caller leaves the data children own (plan E3)', async () => {
		const parent = parentWith({
			show: { ddo_map: [{ tipo: PORTAL_NH, parent: 'self', section_tipo: HOST }] },
			search: { ddo_map: [{ tipo: TEXT_C, parent: PORTAL_NH, section_tipo: TARGET }] },
		});
		const node = await resolveOnHost(PORTAL_NH, parent);
		expect(node.configSource).toBe('own');
		expect(node.injected).toBe(true);
		expect(node.injectedSlots).toEqual(['search']);
		// The question every consumer asks ("are these children the element's
		// own?") reads THIS — false, so the thesaurus-table ddinfo branch
		// (childrenFromOwnConfig), the frame's own children and the child-map
		// origin are not narrowed by a search-only caller.
		expect(node.dataChildrenInjected).toBe(false);
		expect(node.children.map((child) => child.tipo)).toEqual([TEXT_A, TEXT_B]);
	});

	test('stage 1 replaces the show over the own config AND the caller (configSource rqo); a COMPONENT keeps its hide and sqo', async () => {
		const parent = parentWith({
			show: {
				ddo_map: [
					{ tipo: PORTAL_NH, parent: 'self', section_tipo: HOST },
					{ tipo: TEXT_B, parent: PORTAL_NH, section_tipo: TARGET },
				],
			},
		});
		const rqo = {
			source: { tipo: PORTAL_NH, section_tipo: HOST, section_id: HOST_ID, mode: 'list' },
			show: { ddo_map: [{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET }] },
		};
		const node = await resolveOnHost(PORTAL_NH, parent, { rqo });
		expect(node.configSource).toBe('rqo');
		expect(node.key.endsWith('!rqo')).toBe(true);
		expect(slotTipos(node, 'show')).toEqual([TEXT_C]);
		// W5 review (element_node.ts mergeComponentStageOne): only the sent show is
		// the client's — the own hide [B] stays a data child (page 2 must not lose
		// a dataframe rating / geolocation target page 1 had).
		expect(slotTipos(node, 'hide')).toEqual([TEXT_B]);
		expect(node.children.map((child) => child.tipo)).toEqual([TEXT_C, TEXT_B]);
	});

	test("stage 1 on a COMPONENT never echoes the client's sqo: the server's own sqo stays (a fresh fixed_filter)", async () => {
		// The client re-sends the sqo of the context it holds — a fixed_filter
		// expanded from record data on an EARLIER read. Echoing it back would
		// freeze that filter forever (W5 review); the own sqo (re-expanded on
		// every read, explicit.ts) is the one the config carries.
		const stale = [{ $and: [{ q: 'stale_fixed_filter_marker' }] }];
		const rqo = {
			source: { tipo: PORTAL_NH, section_tipo: HOST, section_id: HOST_ID, mode: 'list' },
			show: { ddo_map: [{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET }] },
			sqo: { section_tipo: [TARGET], limit: 1, fixed_filter: stale },
		};
		const node = await resolveOnHost(PORTAL_NH, null, { rqo });
		expect(node.configSource).toBe('rqo');
		expect(JSON.stringify(node.effectiveConfig)).not.toContain('stale_fixed_filter_marker');
		// the own page size (3), not the client's sqo limit
		expect(nodeListPageLimit(node)).toBe(3);
		const own = await resolveOnHost(PORTAL_NH, null);
		const sqoOf = (config: ElementNode['effectiveConfig']) =>
			(config.find((item) => (item.api_engine ?? 'dedalo') === 'dedalo') as { sqo?: unknown })?.sqo;
		expect(sqoOf(node.effectiveConfig)).toEqual(sqoOf(own.effectiveConfig));
	});

	test('one-level expansion: keeps its OWN page size, never its own children', async () => {
		const node = await resolveOnHost(PORTAL_NH, null, { useOwnConfig: false });
		expect(node.children).toHaveLength(0);
		expect(nodeListPageLimit(node)).toBe(3);
	});
});

describe('W2 round-2 gates (default door, diamond, literal frame mode, config lang, client depth)', () => {
	test('(m) a diamond is not a cycle: one record through two paths expands under both, no notice', async () => {
		const nmChildren = (items: Item[]) =>
			items.filter(
				(item) =>
					item.tipo === TEXT_A &&
					item.section_tipo === TARGET &&
					item.from_component_tipo === PORTAL_NM,
			);
		const p1Line = { tipo: PORTAL_P1, section_tipo: HOST, parent: HOST, mode: 'list' };
		const p2Line = { tipo: PORTAL_P2, section_tipo: HOST, parent: HOST, mode: 'list' };
		const one = await readSection(HOST, HOST_ID, 'list', [p1Line]);
		expect(one.ok).toBe(true);
		const perPath = nmChildren(one.items).length;
		expect(perPath).toBeGreaterThan(0);

		const both = await readSection(HOST, HOST_ID, 'list', [p1Line, p2Line]);
		expect(both.errorCode).toBeNull();
		expect(both.ok).toBe(true);
		// MID 1's NM is the SAME occurrence on both paths — an emission-wide
		// visited set would stop the second one (and say so); the per-path guard
		// expands it again.
		expect(both.items.filter((item) => item.tipo === PORTAL_NM)).toHaveLength(2);
		expect(nmChildren(both.items)).toHaveLength(2 * perPath);
		expect(
			both.notices.filter((notice) => notice.code === 'relation.record_cycle_stopped'),
		).toEqual([]);
	});

	for (const mode of ['edit', 'list'] as const) {
		test(`(n) ${mode}: NO client show — the section's declared limit, multi-target child and ddinfo trigger reach the column`, async () => {
			const { ok, items, errorCode } = await readSection(DECLARED_S, 1, mode, null);
			expect(errorCode).toBeNull();
			expect(ok).toBe(true);
			const fromDp = (tipo: string) =>
				items.filter(
					(item) =>
						item.tipo === tipo &&
						item.section_tipo === TARGET &&
						item.from_component_tipo === PORTAL_DP,
				);
			// The section-declared child C replaces DP's own [A, B] — at the TARGET
			// rows although C's declaration names THES first ([THES, TARGET] kept
			// whole, never cut to THES) …
			expect(fromDp(TEXT_A)).toHaveLength(0);
			expect(fromDp(TEXT_B)).toHaveLength(0);
			// … and the column's declared limit 2 is its page (not the edit
			// default, not the list cell's 1).
			expect(new Set(fromDp(TEXT_C).map((item) => item.section_id)).size).toBe(2);
			// The nested value_with_parents child is the ddinfo trigger (the
			// thesaurus-table branch is off: the children are section-declared).
			expect(items.some((item) => item.tipo === TEXT_T && item.section_tipo === THES)).toBe(true);
			expect(
				items.filter((item) => item.tipo === 'ddinfo' && item.section_tipo === THES),
			).toHaveLength(1);
		});
	}

	test('(o) a literal\'s OWN map declaring its frame "mode":"list" wins over the frame node\'s properties.mode', async () => {
		const { ok, items, errorCode } = await readSection(HOST, HOST_ID, 'edit', [
			{ tipo: TEXT_L, section_tipo: HOST, parent: HOST, mode: 'edit' },
		]);
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		const frame = items.find((item) => item.tipo === FRAME_L) as
			| (Item & { mode?: unknown })
			| undefined;
		expect(frame).toBeDefined();
		expect(frame?.mode).toBe('list');
	});

	test('(p) the node builds its own config in the READ lang: filter_by_list equals the context build', async () => {
		const { buildStructureContext } = await import('../../src/core/resolve/structure_context.ts');
		const resolveIn = (configLang?: string) =>
			resolveElement({
				ddo: { tipo: PORTAL_FB, section_tipo: HOST, parent: HOST } as unknown as Ddo,
				parentNode: null,
				ownerSectionTipo: HOST,
				ownerSectionId: HOST_ID,
				mode: 'list',
				lang: 'lg-nolan',
				...(configLang !== undefined ? { configLang } : {}),
				registry: new ElementNodeRegistry(),
				model: 'component_portal',
			});
		type FilterByList = { context?: { lang?: unknown } }[];
		const filterOf = (config: readonly unknown[]): FilterByList | undefined =>
			(config[0] as { sqo?: { filter_by_list?: FilterByList } } | undefined)?.sqo?.filter_by_list;

		const node = await resolveIn('lg-eng');
		expect(node.lang).toBe('lg-nolan');
		const nodeFilter = filterOf(node.effectiveConfig);
		expect(nodeFilter).toHaveLength(1);
		expect(nodeFilter?.[0]?.context?.lang).toBe('lg-eng');

		const context = (await buildStructureContext({
			configFrom: { source: 'own', reason: 'unit-test' },
			tipo: PORTAL_FB,
			sectionTipo: HOST,
			mode: 'list',
			lang: 'lg-eng',
			permissions: 3,
		})) as { request_config?: unknown[] } | null;
		expect(filterOf(context?.request_config ?? [])).toEqual(nodeFilter);

		// The instance lang alone (no configLang) is a DIFFERENT build — the
		// pre-fix data door, which disagreed with its own context.
		expect(filterOf((await resolveIn()).effectiveConfig)?.[0]?.context?.lang).not.toBe('lg-eng');
	});

	test('(q) a CLIENT map past MAX_DDO_DEPTH is refused loudly; the same chain from own configs soft-stops', async () => {
		expect(DEEP_LEVELS).toBe(MAX_DDO_DEPTH + 1);
		const [c0] = DEEP_SECTIONS as [string];
		const p0Line = { tipo: DEEP_PORTALS[0], section_tipo: c0, parent: c0, mode: 'list' };

		// Every level named by the client: P12's children would sit at depth 13.
		const clientMap = [
			p0Line,
			...DEEP_PORTALS.slice(1).map((tipo, index) => ({
				tipo,
				section_tipo: DEEP_SECTIONS[index + 1],
				parent: DEEP_PORTALS[index],
				mode: 'list',
			})),
			{
				tipo: DEEP_TEXT_END,
				section_tipo: DEEP_SECTIONS[DEEP_LEVELS],
				parent: DEEP_PORTALS[DEEP_LEVELS - 1],
				mode: 'list',
			},
		];
		const client = await readSection(c0, 1, 'list', clientMap);
		expect(client.ok).toBe(false);
		expect(client.errorCode).toBe('request.invalid_rqo');

		// The same chain driven by the ONTOLOGY (own configs below the root line).
		const own = await readSection(c0, 1, 'list', [p0Line]);
		expect(own.errorCode).toBeNull();
		expect(own.ok).toBe(true);
		expect(own.items.some((item) => item.tipo === DEEP_TEXT_END)).toBe(false);
		const cut = own.notices.filter((notice) => notice.code === 'relation.depth_bound_stopped');
		expect(cut).toHaveLength(1);
		expect(cut[0]?.details).toMatchObject({
			tipo: DEEP_PORTALS[DEEP_LEVELS - 1],
			section_tipo: DEEP_SECTIONS[DEEP_LEVELS - 1],
			depth: MAX_DDO_DEPTH,
		});
	}, 60000);
});

// ---------------------------------------------------------------------------
// W3 — CONTEXT FROM NODES at every door (section/node_contexts.ts)
// ---------------------------------------------------------------------------
//
// The discriminating shape at every door: NM's (or N's) OWN config shows
// [A, B]; the caller (a section map, a get_data / save show) declares [B, C].
// The context entry the client binds the cells to must say what the DATA did —
// show.ddo_map [B, C], in that order, no A — and the derived child contexts
// must name C and not A. A context rebuilt from the element's own config (the
// pre-W3 shape) carries [A, B] and fails every one of these.

/** The context entry of `tipo` @ `sectionTipo` (all of them, per occurrence). */
const contextsOf = (context: ContextEntry[], tipo: string, sectionTipo: string): ContextEntry[] =>
	context.filter((entry) => entry.tipo === tipo && entry.section_tipo === sectionTipo);

/** The show.ddo_map tipos of a context entry's first request_config item. */
const showOf = (entry: ContextEntry | undefined): string[] =>
	(entry?.request_config?.[0]?.show?.ddo_map ?? []).map((ddo) => ddo.tipo);

/** The derived child contexts at TARGET, in context order. */
const targetContextTipos = (context: ContextEntry[]): unknown[] =>
	context.filter((entry) => entry.section_tipo === TARGET).map((entry) => entry.tipo);

describe('W3 nested ddo CONTEXT (element nodes at every door)', () => {
	for (const mode of ['edit', 'list'] as const) {
		test(`section read ${mode}: NM's context is its node's — [B, C], no A, C's context present, order B, C`, async () => {
			const { ok, context, errorCode } = await readSection(
				HOST,
				HOST_ID,
				mode,
				nestedMap(mode, {}, [TEXT_B, TEXT_C]),
			);
			expect(errorCode).toBeNull();
			expect(ok).toBe(true);
			const nm = contextsOf(context, PORTAL_NM, MID);
			expect(nm).toHaveLength(1);
			expect(showOf(nm[0])).toEqual([TEXT_B, TEXT_C]);
			const targets = targetContextTipos(context);
			expect(targets).not.toContain(TEXT_A);
			expect(targets).toContain(TEXT_C);
			expect(targets.indexOf(TEXT_B)).toBeLessThan(targets.indexOf(TEXT_C));
			// One config per key: nothing is stamped (the wire is unchanged).
			expect(context.some((entry) => entry.caller_chain !== undefined)).toBe(false);
		});
	}

	for (const mode of ['edit', 'list'] as const) {
		test(`section read ${mode}: NM's context sqo.limit IS the governing limit IS the data page`, async () => {
			const { ok, items, context } = await readSection(
				HOST,
				HOST_ID,
				mode,
				nestedMap(mode, { limit: 2 }, [TEXT_B]),
			);
			expect(ok).toBe(true);
			const nm = contextsOf(context, PORTAL_NM, MID)[0];
			expect(nm?.request_config?.[0]?.sqo?.limit).toBe(2);
			expect(new Set(targetItems(items, TEXT_B).map((item) => item.section_id)).size).toBe(2);
		});
	}

	test('get_data (stage 1): the targeted portal N ships the rqo show [B, C], no A context', async () => {
		const { ok, context, errorCode } = await getDataN([
			{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
			{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET },
		]);
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		expect(showOf(contextsOf(context, PORTAL_N, HOST)[0])).toEqual([TEXT_B, TEXT_C]);
		const targets = targetContextTipos(context);
		expect(targets).not.toContain(TEXT_A);
		expect(targets.indexOf(TEXT_B)).toBeLessThan(targets.indexOf(TEXT_C));
	});

	test('get_data of P1: the nested NM context follows the show [B, C] two levels down', async () => {
		const { ok, context, errorCode } = await getDataOf(PORTAL_P1, 'list', [
			{ tipo: PORTAL_NM, parent: 'self', section_tipo: MID, mode: 'list' },
			{ tipo: TEXT_B, parent: PORTAL_NM, section_tipo: TARGET, mode: 'list' },
			{ tipo: TEXT_C, parent: PORTAL_NM, section_tipo: TARGET, mode: 'list' },
		]);
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		const nm = contextsOf(context, PORTAL_NM, MID);
		expect(nm).toHaveLength(1);
		expect(showOf(nm[0])).toEqual([TEXT_B, TEXT_C]);
		expect(targetContextTipos(context)).not.toContain(TEXT_A);
	});

	test('resolve_data: the search-mode portal N ships the stage-1 show [B, C] its data used, no A', async () => {
		const body = (
			await dispatchRqo(
				{
					action: 'read',
					dd_api: 'dd_core_api',
					prevent_lock: true,
					source: {
						typo: 'source',
						type: 'component',
						model: 'component_portal',
						tipo: PORTAL_N,
						section_tipo: HOST,
						section_id: 'search_1',
						mode: 'search',
						lang: 'lg-nolan',
						action: 'resolve_data',
						value: [{ section_tipo: TARGET, section_id: 1, from_component_tipo: PORTAL_N }],
					},
					show: {
						ddo_map: [
							{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
							{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET },
						],
					},
				} as never,
				tsContext as never,
			)
		).body as { ok?: boolean; data?: { context?: ContextEntry[]; data?: Item[] } };
		expect(body.ok).not.toBe(false);
		const context = body.data?.context ?? [];
		const data = body.data?.data ?? [];
		const n = contextsOf(context, PORTAL_N, HOST)[0];
		expect(n).toBeDefined();
		// Stage 1: the read's show [B, C] is N's config — data AND context.
		expect(showOf(n)).toEqual([TEXT_B, TEXT_C]);
		expect(targetItems(data, TEXT_A)).toHaveLength(0);
		expect(targetItems(data, TEXT_C)).toHaveLength(1);
		const targets = targetContextTipos(context);
		expect(targets).not.toContain(TEXT_A);
		expect(targets.indexOf(TEXT_B)).toBeLessThan(targets.indexOf(TEXT_C));
	});

	test('save echo: a portal save carrying its show [B, C] answers the context of the SAME node', async () => {
		const body = (
			await dispatchRqo(
				{
					action: 'save',
					dd_api: 'dd_core_api',
					prevent_lock: true,
					source: {
						typo: 'source',
						type: 'component',
						model: 'component_portal',
						tipo: PORTAL_N,
						section_tipo: HOST,
						section_id: String(HOST_ID),
						mode: 'edit',
						lang: 'lg-nolan',
						action: null,
					},
					show: {
						ddo_map: [
							{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
							{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET },
						],
					},
					data: {
						section_id: String(HOST_ID),
						section_tipo: HOST,
						tipo: PORTAL_N,
						lang: 'lg-nolan',
						from_component_tipo: PORTAL_N,
						// The value it already holds: the echo is the subject, the record is unchanged.
						changed_data: [
							{ action: 'set_data', key: null, value: locators(PORTAL_N, TARGET, TARGET_IDS) },
						],
					},
				} as never,
				tsContext as never,
			)
		).body as {
			ok?: boolean;
			error?: { code?: string };
			data?: { context?: ContextEntry[]; data?: Item[] };
		};
		expect(body.error?.code ?? null).toBeNull();
		const context = body.data?.context ?? [];
		const data = body.data?.data ?? [];
		expect(showOf(contextsOf(context, PORTAL_N, HOST)[0])).toEqual([TEXT_B, TEXT_C]);
		expect(targetItems(data, TEXT_A)).toHaveLength(0);
		expect(targetItems(data, TEXT_C).length).toBeGreaterThan(0);
		const targets = targetContextTipos(context);
		expect(targets).not.toContain(TEXT_A);
		expect(targets).toContain(TEXT_C);
	});

	// A ddo_map names a child's parent by TIPO only, so one flat map cannot give
	// NM different children under P1 and P2 (both lines would be NM's). The
	// per-occurrence split is reached the way tch197 reached it: one parent
	// names NM's children, the other leaves NM to its OWN config.
	test('(b) per occurrence: NM under P1 (caller [B]) and under P2 (own [A, B]) ship TWO contexts with caller_chain', async () => {
		const { ok, items, context } = await readSection(HOST, HOST_ID, 'list', [
			{ tipo: PORTAL_P1, section_tipo: HOST, parent: HOST, mode: 'list' },
			{ tipo: PORTAL_NM, section_tipo: MID, parent: PORTAL_P1, mode: 'list' },
			{ tipo: TEXT_B, section_tipo: TARGET, parent: PORTAL_NM, mode: 'list' },
			{ tipo: PORTAL_P2, section_tipo: HOST, parent: HOST, mode: 'list' },
		]);
		expect(ok).toBe(true);
		const nm = contextsOf(context, PORTAL_NM, MID);
		expect(nm).toHaveLength(2);
		const byChain = new Map(nm.map((entry) => [entry.caller_chain, showOf(entry)]));
		expect(byChain.get(PORTAL_P1)).toEqual([TEXT_B]);
		expect(byChain.get(PORTAL_P2)).toEqual([TEXT_A, TEXT_B]);
		// The data items of NM carry the chain of the context they bind to.
		const nmItems = items.filter((item) => item.tipo === PORTAL_NM && item.section_tipo === MID);
		const chains = new Set(
			nmItems.map((item) => (item as { caller_chain?: unknown }).caller_chain),
		);
		expect(chains).toEqual(new Set([PORTAL_P1, PORTAL_P2]));
		// Each NM CELL's data matches ITS occurrence: the TARGET children emitted
		// after an NM item (up to the next portal item) are exactly the show map
		// of the context its caller_chain names — [B] under P1, [A, B] under P2.
		// A swapped stamp (P1's cell carrying 'P2') fails here.
		const portals = new Set<unknown>([PORTAL_P1, PORTAL_P2, PORTAL_NM]);
		const cells = items.flatMap((item, index) => {
			if (item.tipo !== PORTAL_NM || item.section_tipo !== MID) return [];
			const children: unknown[] = [];
			for (const next of items.slice(index + 1)) {
				if (portals.has(next.tipo)) break;
				if (next.section_tipo === TARGET) children.push(next.tipo);
			}
			return [{ chain: (item as { caller_chain?: unknown }).caller_chain, children }];
		});
		expect(cells).toHaveLength(2);
		for (const cell of cells) {
			expect(cell.children.length).toBeGreaterThan(0);
			expect(new Set(cell.children)).toEqual(new Set(byChain.get(cell.chain as string)));
		}
		// A's context exists (P2's NM shows it); its single key stays unstamped.
		const aContexts = contextsOf(context, TEXT_A, TARGET);
		expect(aContexts).toHaveLength(1);
		expect(aContexts[0]?.caller_chain).toBeUndefined();
	});

	test('(b) identical configs under P1 and P2 (both own): ONE context, nothing stamped (first-wins)', async () => {
		const { ok, items, context } = await readSection(HOST, HOST_ID, 'list', [
			{ tipo: PORTAL_P1, section_tipo: HOST, parent: HOST, mode: 'list' },
			{ tipo: PORTAL_P2, section_tipo: HOST, parent: HOST, mode: 'list' },
		]);
		expect(ok).toBe(true);
		// NM is emitted under BOTH parents …
		expect(
			items.filter((item) => item.tipo === PORTAL_NM && item.section_tipo === MID).length,
		).toBeGreaterThanOrEqual(2);
		// … and ships one context: the configs are identical.
		const nm = contextsOf(context, PORTAL_NM, MID);
		expect(nm).toHaveLength(1);
		expect(showOf(nm[0])).toEqual([TEXT_A, TEXT_B]);
		expect(nm[0]?.caller_chain).toBeUndefined();
		expect(context.some((entry) => entry.caller_chain !== undefined)).toBe(false);
		expect(
			items.some((item) => (item as { caller_chain?: unknown }).caller_chain !== undefined),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// W3 — the remaining context doors (each one: context == the node the data
// was emitted from, discriminated own [A,B] vs caller [B,C])
// ---------------------------------------------------------------------------

/** A get_data read through the real door: any component, any record, optional show / limit. */
async function getDataAt(input: {
	tipo: string;
	model: string;
	sectionTipo: string;
	sectionId: number;
	mode: 'edit' | 'list';
	show?: Record<string, unknown>[];
	limit?: number | null;
}): Promise<{ ok: boolean; items: Item[]; context: ContextEntry[]; errorCode: string | null }> {
	const rqo: Record<string, unknown> = {
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		source: {
			typo: 'source',
			type: 'component',
			action: 'get_data',
			model: input.model,
			tipo: input.tipo,
			section_tipo: input.sectionTipo,
			section_id: input.sectionId,
			mode: input.mode,
			lang: 'lg-nolan',
		},
		sqo: {
			section_tipo: [input.sectionTipo],
			limit: input.limit === undefined ? 10 : input.limit,
			offset: 0,
			filter_by_locators: [{ section_tipo: input.sectionTipo, section_id: input.sectionId }],
		},
	};
	if (input.show !== undefined) rqo.show = { ddo_map: input.show };
	const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
		ok?: boolean;
		data?: { data?: Item[]; context?: ContextEntry[] };
		error?: { code?: string };
	};
	return {
		ok: body.ok !== false,
		items: body.data?.data ?? [],
		context: body.data?.context ?? [],
		errorCode: body.error?.code ?? null,
	};
}

/** A save through the real door: `changed_data` on `tipo` @ `sectionTipo`/`sectionId`, with a show. */
async function saveVia(input: {
	tipo: string;
	sectionTipo: string;
	sectionId: number;
	show: Record<string, unknown>[];
	changedData: Record<string, unknown>[];
	pagination?: Record<string, unknown>;
}): Promise<{ errorCode: string | null; items: Item[]; context: ContextEntry[] }> {
	const body = (
		await dispatchRqo(
			{
				action: 'save',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					typo: 'source',
					type: 'component',
					model: 'component_portal',
					tipo: input.tipo,
					section_tipo: input.sectionTipo,
					section_id: String(input.sectionId),
					mode: 'edit',
					lang: 'lg-nolan',
					action: null,
				},
				show: { ddo_map: input.show },
				data: {
					section_id: String(input.sectionId),
					section_tipo: input.sectionTipo,
					tipo: input.tipo,
					lang: 'lg-nolan',
					from_component_tipo: input.tipo,
					changed_data: input.changedData,
					...(input.pagination !== undefined ? { pagination: input.pagination } : {}),
				},
			} as never,
			tsContext as never,
		)
	).body as {
		error?: { code?: string };
		data?: { context?: ContextEntry[]; data?: Item[] };
	};
	return {
		errorCode: body.error?.code ?? null,
		items: body.data?.data ?? [],
		context: body.data?.context ?? [],
	};
}

/** The tipos of the items emitted at `sectionTipo`. */
const tiposAt = (items: Item[], sectionTipo: string): Set<unknown> =>
	new Set(items.filter((item) => item.section_tipo === sectionTipo).map((item) => item.tipo));

/** P1's show: NM under P1, and NM's children [B, C] — the nested caller every nested door sends. */
const P1_SHOW_BC = [
	{ tipo: PORTAL_NM, parent: 'self', section_tipo: MID, mode: 'list' },
	{ tipo: TEXT_B, parent: PORTAL_NM, section_tipo: TARGET, mode: 'list' },
	{ tipo: TEXT_C, parent: PORTAL_NM, section_tipo: TARGET, mode: 'list' },
];

/** A dd15 read through the real door (root, TM read surface), with a column map. */
async function readTmVia(
	sqo: Record<string, unknown>,
	ddoMap: Record<string, unknown>[],
): Promise<{ errorCode: string | null; items: Item[]; context: ContextEntry[] }> {
	const body = (
		await dispatchRqo(
			{
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
					...sqo,
				},
				show: { ddo_map: ddoMap },
			} as never,
			tsContext as never,
		)
	).body as { error?: { code?: string }; data?: { context?: ContextEntry[]; data?: Item[] } };
	return {
		errorCode: body.error?.code ?? null,
		items: (body.data?.data ?? []).filter((item) => item.typo !== 'sections'),
		context: body.data?.context ?? [],
	};
}

describe('W3 nested ddo CONTEXT — the remaining doors', () => {
	test("section door ORDER (PHP traversal): P2's undeclared subcontexts follow P2, before the next column N", async () => {
		const { ok, context } = await readSection(HOST, HOST_ID, 'list', [
			{ tipo: PORTAL_P2, section_tipo: HOST, parent: HOST, mode: 'list' },
			{ tipo: PORTAL_N, section_tipo: HOST, parent: HOST, mode: 'list' },
		]);
		expect(ok).toBe(true);
		const at = (tipo: string, sectionTipo: string) =>
			context.findIndex((entry) => entry.tipo === tipo && entry.section_tipo === sectionTipo);
		const p2 = at(PORTAL_P2, HOST);
		const nm = at(PORTAL_NM, MID);
		const a = at(TEXT_A, TARGET);
		const n = at(PORTAL_N, HOST);
		for (const index of [p2, nm, a, n]) expect(index).toBeGreaterThanOrEqual(0);
		expect(p2).toBeLessThan(nm);
		expect(nm).toBeLessThan(a);
		expect(a).toBeLessThan(n);
	});

	test('literal get_data (stage 1): the frame follows the rqo show — context and data are ONE node', async () => {
		// TEXT_H's frame FH OWNS [PT]; the rqo targets TEXT_H with FH → [C].
		const { ok, items, context, errorCode } = await getDataAt({
			tipo: TEXT_H,
			model: 'component_input_text',
			sectionTipo: HOST,
			sectionId: HOST_ID,
			mode: 'edit',
			show: [
				{ tipo: FRAME_H, parent: 'self', section_tipo: HOST, mode: 'edit' },
				{ tipo: TEXT_C, parent: FRAME_H, section_tipo: TARGET, mode: 'list' },
			],
		});
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		const main = contextsOf(context, TEXT_H, HOST);
		expect(main).toHaveLength(1);
		expect(showOf(main[0])).toEqual([FRAME_H, TEXT_C]);
		const frame = contextsOf(context, FRAME_H, HOST);
		expect(frame).toHaveLength(1);
		expect(showOf(frame[0])).toEqual([TEXT_C]);
		// The DATA took the same node: the frame's children are [C], never its own PT.
		const emitted = tiposAt(items, TARGET);
		expect(emitted.has(TEXT_C)).toBe(true);
		expect(emitted.has(PORTAL_T)).toBe(false);
		expect(targetContextTipos(context)).not.toContain(PORTAL_T);
	});

	test('relation_index get_data, own config: context show == the emitted children, then with a show', async () => {
		const own = await getDataAt({
			tipo: INDEX_RI,
			model: 'component_relation_index',
			sectionTipo: TARGET,
			sectionId: 1,
			mode: 'edit',
		});
		expect(own.errorCode).toBeNull();
		expect(own.ok).toBe(true);
		const ownEntry = contextsOf(own.context, INDEX_RI, TARGET);
		expect(ownEntry).toHaveLength(1);
		expect(showOf(ownEntry[0])).toEqual([TEXT_RA, TEXT_RB]);
		const ownEmitted = tiposAt(own.items, REF);
		expect(ownEmitted.has(TEXT_RA)).toBe(true);
		expect(ownEmitted.has(TEXT_RC)).toBe(false);

		const shown = await getDataAt({
			tipo: INDEX_RI,
			model: 'component_relation_index',
			sectionTipo: TARGET,
			sectionId: 1,
			mode: 'edit',
			show: [
				{ tipo: TEXT_RB, parent: 'self', section_tipo: REF },
				{ tipo: TEXT_RC, parent: 'self', section_tipo: REF },
			],
		});
		expect(shown.errorCode).toBeNull();
		const shownEntry = contextsOf(shown.context, INDEX_RI, TARGET);
		expect(shownEntry).toHaveLength(1);
		expect(showOf(shownEntry[0])).toEqual([TEXT_RB, TEXT_RC]);
		// Stage 1 reached the DATA too (the pinned target node): C in, A out.
		const shownEmitted = tiposAt(shown.items, REF);
		expect(shownEmitted.has(TEXT_RC)).toBe(true);
		expect(shownEmitted.has(TEXT_RA)).toBe(false);
		const refContexts = shown.context
			.filter((entry) => entry.section_tipo === REF)
			.map((entry) => entry.tipo);
		expect(refContexts).not.toContain(TEXT_RA);
		expect(refContexts.indexOf(TEXT_RB)).toBeLessThan(refContexts.indexOf(TEXT_RC));
	});

	test('relation_index get_data paging: context sqo.limit == the page limit == the records emitted', async () => {
		const { ok, items, context } = await getDataAt({
			tipo: INDEX_RI,
			model: 'component_relation_index',
			sectionTipo: TARGET,
			sectionId: 1,
			mode: 'edit',
			limit: 1,
		});
		expect(ok).toBe(true);
		const entry = contextsOf(context, INDEX_RI, TARGET)[0];
		expect(entry?.request_config?.[0]?.sqo?.limit).toBe(1);
		const main = items.find((item) => item.tipo === INDEX_RI) as
			| (Item & { pagination?: { limit?: unknown; total?: unknown; offset?: unknown } })
			| undefined;
		expect(main?.pagination?.limit).toBe(1);
		expect(main?.pagination?.total).toBe(REF_IDS.length);
		const pageIds = new Set(
			items
				.filter((item) => item.section_tipo === REF && item.tipo === TEXT_RA)
				.map((item) => item.section_id),
		);
		expect(pageIds.size).toBe(1);
	});

	test('relation_index section column: own config [RA, RB], and the caller map [RB, RC]', async () => {
		const own = await readSection(TARGET, 1, 'edit', [
			{ tipo: INDEX_RI, section_tipo: TARGET, parent: TARGET, mode: 'edit' },
		]);
		expect(own.errorCode).toBeNull();
		expect(showOf(contextsOf(own.context, INDEX_RI, TARGET)[0])).toEqual([TEXT_RA, TEXT_RB]);
		expect(tiposAt(own.items, REF).has(TEXT_RA)).toBe(true);

		const caller = await readSection(TARGET, 1, 'edit', [
			{ tipo: INDEX_RI, section_tipo: TARGET, parent: TARGET, mode: 'edit' },
			{ tipo: TEXT_RB, section_tipo: REF, parent: INDEX_RI, mode: 'list' },
			{ tipo: TEXT_RC, section_tipo: REF, parent: INDEX_RI, mode: 'list' },
		]);
		expect(caller.errorCode).toBeNull();
		const entry = contextsOf(caller.context, INDEX_RI, TARGET);
		expect(entry).toHaveLength(1);
		expect(showOf(entry[0])).toEqual([TEXT_RB, TEXT_RC]);
		const emitted = tiposAt(caller.items, REF);
		expect(emitted.has(TEXT_RC)).toBe(true);
		expect(emitted.has(TEXT_RA)).toBe(false);
	});

	test('get_data paging WITHOUT a show (the PHP-limit control): own map, context limit == page', async () => {
		const { ok, items, context } = await getDataAt({
			tipo: PORTAL_N,
			model: 'component_portal',
			sectionTipo: HOST,
			sectionId: HOST_ID,
			mode: 'edit',
			limit: 2,
		});
		expect(ok).toBe(true);
		const n = contextsOf(context, PORTAL_N, HOST);
		expect(n).toHaveLength(1);
		expect(showOf(n[0])).toEqual([TEXT_A, TEXT_B]);
		expect(n[0]?.request_config?.[0]?.sqo?.limit).toBe(2);
		expect(new Set(targetItems(items, TEXT_A).map((item) => item.section_id)).size).toBe(2);
		expect(targetItems(items, TEXT_C)).toHaveLength(0);
	});

	test('get_data paging WITH the show (decision (a)): [B, C], context limit == page', async () => {
		const { ok, items, context } = await getDataAt({
			tipo: PORTAL_N,
			model: 'component_portal',
			sectionTipo: HOST,
			sectionId: HOST_ID,
			mode: 'edit',
			limit: 2,
			show: [
				{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
				{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET },
			],
		});
		expect(ok).toBe(true);
		const n = contextsOf(context, PORTAL_N, HOST)[0];
		expect(showOf(n)).toEqual([TEXT_B, TEXT_C]);
		expect(n?.request_config?.[0]?.sqo?.limit).toBe(2);
		expect(new Set(targetItems(items, TEXT_C).map((item) => item.section_id)).size).toBe(2);
		expect(targetItems(items, TEXT_A)).toHaveLength(0);
	});

	test('NESTED save echo: P1 saved with NM → [B, C] answers NM context [B, C] from the echo nodes', async () => {
		const echo = await saveVia({
			tipo: PORTAL_P1,
			sectionTipo: HOST,
			sectionId: HOST_ID,
			show: P1_SHOW_BC,
			changedData: [{ action: 'set_data', key: null, value: locators(PORTAL_P1, MID, [MID_ID]) }],
		});
		expect(echo.errorCode).toBeNull();
		const nm = contextsOf(echo.context, PORTAL_NM, MID);
		expect(nm).toHaveLength(1);
		// A bare echo (no echo nodes) would rebuild NM from its OWN [A, B].
		expect(showOf(nm[0])).toEqual([TEXT_B, TEXT_C]);
		expect(targetItems(echo.items, TEXT_A)).toHaveLength(0);
		expect(targetItems(echo.items, TEXT_C).length).toBeGreaterThan(0);
		expect(targetContextTipos(echo.context)).not.toContain(TEXT_A);
	});

	test('NESTED resolve_data: P1 with NM → [B, C] answers NM context [B, C] from the read nodes', async () => {
		const body = (
			await dispatchRqo(
				{
					action: 'read',
					dd_api: 'dd_core_api',
					prevent_lock: true,
					source: {
						typo: 'source',
						type: 'component',
						model: 'component_portal',
						tipo: PORTAL_P1,
						section_tipo: HOST,
						section_id: 'search_1',
						mode: 'search',
						lang: 'lg-nolan',
						action: 'resolve_data',
						value: [{ section_tipo: MID, section_id: MID_ID, from_component_tipo: PORTAL_P1 }],
					},
					show: { ddo_map: P1_SHOW_BC },
				} as never,
				tsContext as never,
			)
		).body as { ok?: boolean; data?: { context?: ContextEntry[]; data?: Item[] } };
		expect(body.ok).not.toBe(false);
		const context = body.data?.context ?? [];
		const nm = contextsOf(context, PORTAL_NM, MID);
		expect(nm).toHaveLength(1);
		expect(showOf(nm[0])).toEqual([TEXT_B, TEXT_C]);
		expect(targetItems(body.data?.data ?? [], TEXT_A)).toHaveLength(0);
		expect(targetContextTipos(context)).not.toContain(TEXT_A);
	});

	test('TM framed (a per-component row) and whole-record row: the column context IS the emitted node, mode list', async () => {
		await recordTimeMachine(
			{
				sectionTipo: HOST,
				sectionId: HOST_ID,
				componentTipo: PORTAL_N,
				lang: 'lg-nolan',
				userId: -1,
				data: locators(PORTAL_N, TARGET, TARGET_IDS),
			},
			'2026-11-03 10:00:00',
		);
		await recordTimeMachine(
			{
				sectionTipo: HOST,
				sectionId: HOST_ID,
				componentTipo: HOST,
				lang: 'lg-nolan',
				userId: -1,
				data: { relation: { [PORTAL_N]: locators(PORTAL_N, TARGET, TARGET_IDS) } },
			},
			'2026-11-03 10:00:01',
		);
		// The dd15 column map: N, and N's children [B, C] (the client's map — the
		// read's ROOT, so N's cells take them, exactly like a section map).
		const tmMap = [
			{ tipo: PORTAL_N, section_tipo: HOST },
			{ tipo: TEXT_B, section_tipo: TARGET, parent: PORTAL_N },
			{ tipo: TEXT_C, section_tipo: TARGET, parent: PORTAL_N },
		];
		const surfaces = {
			// The locator names the component (tipo): ONLY per-component rows, so the
			// whole-record row recorded above cannot supply this surface's node.
			framed: {
				section_tipo: [HOST],
				filter_by_locators: [{ section_tipo: HOST, section_id: HOST_ID, tipo: PORTAL_N }],
			},
			wholeRecord: { section_tipo: [HOST], filter: { $and: [{ q: HOST, column_name: 'tipo' }] } },
		};
		for (const [surface, sqo] of Object.entries(surfaces)) {
			const { errorCode, items, context } = await readTmVia(sqo, tmMap);
			expect(errorCode, surface).toBeNull();
			const column = contextsOf(context, PORTAL_N, 'dd15');
			expect(column, surface).toHaveLength(1);
			expect(column[0]?.mode, surface).toBe('list');
			const emitted = tiposAt(items, TARGET);
			expect(emitted.has(TEXT_C), surface).toBe(true);
			expect(emitted.has(TEXT_A), surface).toBe(false);
			// The context says what the cells did (an own-config context: [A, B]).
			expect(showOf(column[0]), surface).toEqual([TEXT_B, TEXT_C]);
		}
	});

	test('save echo LAST-PAGE SWAP: an insert on a paged N answers the last page, its context from that read', async () => {
		try {
			const echo = await saveVia({
				tipo: PORTAL_N,
				sectionTipo: HOST,
				sectionId: HOST_ID,
				show: [
					{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
					{ tipo: TEXT_C, parent: 'self', section_tipo: TARGET },
				],
				changedData: [
					{
						action: 'insert',
						key: null,
						value: {
							type: 'dd151',
							section_tipo: TARGET,
							section_id: TARGET_EXTRA_ID,
							from_component_tipo: PORTAL_N,
						},
					},
				],
				pagination: { limit: 1, offset: 0, total: TARGET_IDS.length },
			});
			expect(echo.errorCode).toBeNull();
			const main = echo.items.find(
				(item) => item.tipo === PORTAL_N && item.section_tipo === HOST,
			) as (Item & { pagination?: { offset?: unknown; total?: unknown } }) | undefined;
			expect(main).toBeDefined();
			// The LAST page (offset 3 of 4 at limit 1) — where the inserted locator lives.
			expect(main?.pagination?.total).toBe(TARGET_IDS.length + 1);
			expect(main?.pagination?.offset).toBe(TARGET_IDS.length);
			expect(targetItems(echo.items, TEXT_C).map((item) => item.section_id)).toEqual([
				TARGET_EXTRA_ID,
			]);
			const n = contextsOf(echo.context, PORTAL_N, HOST);
			expect(n).toHaveLength(1);
			expect(showOf(n[0])).toEqual([TEXT_B, TEXT_C]);
			expect(n[0]?.request_config?.[0]?.sqo?.limit).toBe(1);
			expect(targetContextTipos(echo.context)).not.toContain(TEXT_A);
		} finally {
			// N back to the three locators every other case reads.
			const restored = await saveVia({
				tipo: PORTAL_N,
				sectionTipo: HOST,
				sectionId: HOST_ID,
				show: [
					{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET },
					{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
				],
				changedData: [
					{ action: 'set_data', key: null, value: locators(PORTAL_N, TARGET, TARGET_IDS) },
				],
			});
			expect(restored.errorCode).toBeNull();
		}
	});

	test('save echo LAST-PAGE SWAP reads its context from the LAST page, not page 1', async () => {
		// N shows RI (the relation_index on TARGET): REF records index TARGET 1
		// only. Page 1 (limit 1) is TARGET 1 → RA/RB@REF items under RI; the last
		// page is the inserted TARGET 4 → RI indexes nothing there. A context
		// built from page 1 would carry RA@REF; the last page's carries none.
		const show = [
			{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
			{ tipo: INDEX_RI, parent: 'self', section_tipo: TARGET },
		];
		// Positive control: page 1 of the same map DOES derive the RA@REF context.
		const firstPage = await getDataAt({
			tipo: PORTAL_N,
			model: 'component_portal',
			sectionTipo: HOST,
			sectionId: HOST_ID,
			mode: 'edit',
			show,
			limit: 1,
		});
		expect(firstPage.errorCode).toBeNull();
		expect(contextsOf(firstPage.context, TEXT_RA, REF)).toHaveLength(1);
		try {
			const echo = await saveVia({
				tipo: PORTAL_N,
				sectionTipo: HOST,
				sectionId: HOST_ID,
				show,
				changedData: [
					{
						action: 'insert',
						key: null,
						value: {
							type: 'dd151',
							section_tipo: TARGET,
							section_id: TARGET_EXTRA_ID,
							from_component_tipo: PORTAL_N,
						},
					},
				],
				pagination: { limit: 1, offset: 0, total: TARGET_IDS.length },
			});
			expect(echo.errorCode).toBeNull();
			const main = echo.items.find(
				(item) => item.tipo === PORTAL_N && item.section_tipo === HOST,
			) as (Item & { pagination?: { offset?: unknown } }) | undefined;
			expect(main?.pagination?.offset).toBe(TARGET_IDS.length);
			// The last page's TARGET 4 cell is there (its B); RI indexes nothing on it.
			expect(targetItems(echo.items, TEXT_B).map((item) => item.section_id)).toEqual([
				TARGET_EXTRA_ID,
			]);
			expect(contextsOf(echo.context, TEXT_RA, REF)).toHaveLength(0);
		} finally {
			const restored = await saveVia({
				tipo: PORTAL_N,
				sectionTipo: HOST,
				sectionId: HOST_ID,
				show: [
					{ tipo: TEXT_A, parent: 'self', section_tipo: TARGET },
					{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
				],
				changedData: [
					{ action: 'set_data', key: null, value: locators(PORTAL_N, TARGET, TARGET_IDS) },
				],
			});
			expect(restored.errorCode).toBeNull();
		}
	});
});

describe('W3 nested ddo CONTEXT — order-independence, traversal order, page size', () => {
	for (const mode of ['edit', 'list'] as const) {
		test(`section read ${mode}: a map listing NM's children and NM BEFORE P1 still ships NM's node context [B, C]`, async () => {
			// The data side collects children by parent alone, whatever the map
			// order; the column pass must resolve NM's parent node the same way, or
			// NM ships an own-config [A, B] entry that absorbs the node-built one.
			// Children first (B before C, so the caller order stays [B, C]), then NM,
			// then P1.
			const [p1Line, nmLine, ...childLines] = nestedMap(mode, {}, [TEXT_B, TEXT_C]);
			const reversed = [...childLines, nmLine, p1Line] as Record<string, unknown>[];
			const { ok, items, context, errorCode } = await readSection(HOST, HOST_ID, mode, reversed);
			expect(errorCode).toBeNull();
			expect(ok).toBe(true);
			expect(targetItems(items, TEXT_C).length).toBeGreaterThan(0);
			expect(targetItems(items, TEXT_A)).toHaveLength(0);
			const nm = contextsOf(context, PORTAL_NM, MID);
			expect(nm).toHaveLength(1);
			expect(showOf(nm[0])).toEqual([TEXT_B, TEXT_C]);
			expect(targetContextTipos(context)).not.toContain(TEXT_A);
		});
	}

	test('section read: a nested component whose parent the map never lists ships NO column entry', async () => {
		// NM's parent P1 is absent: the data side never expands NM, so no context
		// may describe it (an own-config entry would describe nothing emitted).
		const { ok, context } = await readSection(HOST, HOST_ID, 'list', [
			{ tipo: PORTAL_N, section_tipo: HOST, parent: HOST, mode: 'list' },
			{ tipo: PORTAL_NM, section_tipo: MID, parent: PORTAL_P1, mode: 'list' },
		]);
		expect(ok).toBe(true);
		expect(contextsOf(context, PORTAL_NM, MID)).toHaveLength(0);
	});

	test('get_data ORDER (PHP traversal): a nested framed literal ships its context BEFORE its frame', async () => {
		// CB @ CHAIN_B 6 → CHAIN_A 7, whose TEXT_CA pairs a FRAME_CA entry. The
		// data emits the frame items before the literal's item (as PHP data does);
		// the context must still be element first, then its subcontexts.
		const { ok, items, context, errorCode } = await getDataAt({
			tipo: PORTAL_CB,
			model: 'component_portal',
			sectionTipo: CHAIN_B,
			sectionId: FRAME_AT_DEPTH_ID - 1,
			mode: 'edit',
			show: [{ tipo: TEXT_CA, parent: 'self', section_tipo: CHAIN_A }],
		});
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		const itemAt = (tipo: string) => items.findIndex((item) => item.tipo === tipo);
		// The precondition the order fix is about: frame data ahead of its literal.
		expect(itemAt(FRAME_CA)).toBeGreaterThanOrEqual(0);
		expect(itemAt(FRAME_CA)).toBeLessThan(itemAt(TEXT_CA));
		const at = (tipo: string) => context.findIndex((entry) => entry.tipo === tipo);
		expect(at(TEXT_CA)).toBeGreaterThanOrEqual(0);
		expect(at(TEXT_CA)).toBeLessThan(at(FRAME_CA));
		expect(at(FRAME_CA)).toBeLessThan(at(TEXT_A));
	});

	test('TM column: a config declaring sqo.limit 4 and show.sqo_config.limit 2 ships sqo.limit == the cell page (2)', async () => {
		await recordTimeMachine(
			{
				sectionTipo: HOST,
				sectionId: HOST_ID,
				componentTipo: PORTAL_PL,
				lang: 'lg-nolan',
				userId: -1,
				data: locators(PORTAL_PL, TARGET, TARGET_IDS),
			},
			'2026-11-03 11:00:00',
		);
		const { errorCode, items, context } = await readTmVia(
			{
				section_tipo: [HOST],
				filter_by_locators: [{ section_tipo: HOST, section_id: HOST_ID, tipo: PORTAL_PL }],
			},
			[{ tipo: PORTAL_PL, section_tipo: HOST }],
		);
		expect(errorCode).toBeNull();
		const cellIds = new Set(
			targetItems(items, TEXT_B)
				.filter((item) => item.from_component_tipo === PORTAL_PL)
				.map((item) => item.section_id),
		);
		expect(cellIds.size).toBe(2);
		const column = contextsOf(context, PORTAL_PL, 'dd15');
		expect(column).toHaveLength(1);
		expect(column[0]?.request_config?.[0]?.sqo?.limit).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// W3 adversarial round: stage 1 at the component-sourced rows door, the TM
// column order, governing properties through Site A, the (b) fingerprint
// ---------------------------------------------------------------------------

/** A COMPONENT-sourced rows read (the service_autocomplete search shape): source = portal N, rows = its target. */
async function readTargetsVia(
	ddoMap: Record<string, unknown>[],
): Promise<{ errorCode: string | null; items: Item[]; context: ContextEntry[] }> {
	const body = (
		await dispatchRqo(
			{
				action: 'read',
				dd_api: 'dd_core_api',
				prevent_lock: true,
				source: {
					typo: 'source',
					model: 'component_portal',
					tipo: PORTAL_N,
					section_tipo: HOST,
					action: 'search',
					mode: 'list',
					lang: 'lg-nolan',
					session_save: false,
				},
				sqo: {
					section_tipo: [TARGET],
					limit: TARGET_IDS.length,
					offset: 0,
					filter_by_locators: TARGET_IDS.map((id) => ({
						section_tipo: TARGET,
						section_id: String(id),
					})),
				},
				show: { ddo_map: ddoMap },
			} as never,
			tsContext as never,
		)
	).body as { error?: { code?: string }; data?: { context?: ContextEntry[]; data?: Item[] } };
	return {
		errorCode: body.error?.code ?? null,
		items: (body.data?.data ?? []).filter((item) => item.typo !== 'sections'),
		context: body.data?.context ?? [],
	};
}

describe('W3 adversarial round', () => {
	test('component-sourced rows read: stage 1 runs per TARGET section — an invalid client ddo is dropped, the valid ones emit and are consolidated', async () => {
		const { errorCode, items, context } = await readTargetsVia([
			{ tipo: TEXT_A, parent: PORTAL_N, section_tipo: TARGET, mode: 'list' },
			// unknown tipo: stage-1 validation drops it (the literal reached emitDdoData and threw)
			{ tipo: 'zzni99999', parent: PORTAL_N, section_tipo: TARGET, mode: 'list' },
			// 'self' section + no mode: consolidated against the target section
			{ tipo: TEXT_C, parent: 'self', section_tipo: 'self' },
		]);
		expect(errorCode).toBeNull();
		const emitted = tiposAt(items, TARGET);
		expect(emitted.has(TEXT_A)).toBe(true);
		expect(emitted.has(TEXT_C)).toBe(true);
		expect(items.some((item) => item.tipo === 'zzni99999')).toBe(false);
		// TEXT_C's consolidated line: its section is the TARGET, its mode the read's
		const cContexts = contextsOf(context, TEXT_C, TARGET);
		expect(cContexts).toHaveLength(1);
		expect(cContexts[0]?.mode).toBe('list');
	});

	test("TM column ORDER: a subject-component column's subcontexts follow IT, before the next dd15 column", async () => {
		await recordTimeMachine(
			{
				sectionTipo: HOST,
				sectionId: HOST_ID,
				componentTipo: PORTAL_N,
				lang: 'lg-nolan',
				userId: -1,
				data: locators(PORTAL_N, TARGET, TARGET_IDS),
			},
			'2026-11-03 11:00:00',
		);
		const { errorCode, context } = await readTmVia(
			{
				section_tipo: [HOST],
				filter_by_locators: [{ section_tipo: HOST, section_id: HOST_ID, tipo: PORTAL_N }],
			},
			[
				{ tipo: PORTAL_N, section_tipo: HOST },
				{ tipo: TEXT_B, section_tipo: TARGET, parent: PORTAL_N },
				{ tipo: TEXT_C, section_tipo: TARGET, parent: PORTAL_N },
				{ tipo: PORTAL_P1, section_tipo: HOST },
			],
		);
		expect(errorCode).toBeNull();
		const indexOf = (tipo: string, section: string) =>
			context.findIndex((entry) => entry.tipo === tipo && entry.section_tipo === section);
		const n = indexOf(PORTAL_N, 'dd15');
		const b = indexOf(TEXT_B, TARGET);
		const c = indexOf(TEXT_C, TARGET);
		const p1 = indexOf(PORTAL_P1, 'dd15');
		for (const index of [n, b, c, p1]) expect(index).toBeGreaterThanOrEqual(0);
		// get_subdatum order: N, then N's subcontexts, then the next column
		expect(b).toBeGreaterThan(n);
		expect(c).toBeGreaterThan(n);
		expect(b).toBeLessThan(p1);
		expect(c).toBeLessThan(p1);
	});

	test('governing properties go through Site A: a governing css is the context css (edit), never properties.css', async () => {
		const css = { '.wrapper_component': { 'grid-column': 'span 3' } };
		const { ok, context } = await readSection(HOST, HOST_ID, 'edit', [
			{
				tipo: PORTAL_N,
				section_tipo: HOST,
				parent: HOST,
				mode: 'edit',
				properties: { css, zz_governed_flag: 'kept' },
			},
		]);
		expect(ok).toBe(true);
		const entry = contextsOf(context, PORTAL_N, HOST)[0] as
			| (ContextEntry & { css?: unknown; properties?: Record<string, unknown> })
			| undefined;
		expect(entry).toBeDefined();
		expect(entry?.properties?.css).toBeUndefined();
		expect(entry?.properties?.zz_governed_flag).toBe('kept');
		expect(entry?.css).toEqual(css);
	});

	test('governing properties in LIST: the css never ships inside properties', async () => {
		const { ok, context } = await readSection(HOST, HOST_ID, 'list', [
			{
				tipo: PORTAL_N,
				section_tipo: HOST,
				parent: HOST,
				mode: 'list',
				properties: { css: { '.x': { color: 'red' } } },
			},
		]);
		expect(ok).toBe(true);
		const entry = contextsOf(context, PORTAL_N, HOST)[0] as
			| (ContextEntry & { properties?: Record<string, unknown> })
			| undefined;
		expect(entry).toBeDefined();
		expect(entry?.properties?.css).toBeUndefined();
	});

	test('(b) fingerprint: same config, different governing view → two contexts; identical projections → one', () => {
		const registry = new ElementNodeRegistry();
		const contexts = new NodeContextSet(registry);
		const base = parentWith({ show: { ddo_map: [{ tipo: TEXT_A }] } });
		const sameAsBase = { ...base, key: 'probe-same' };
		const otherView = { ...base, key: 'probe-view', view: 'mini' };
		const otherGrouper = { ...base, key: 'probe-grouper', parent_grouper: 'zzni1' };
		const otherProperties = { ...base, key: 'probe-properties', properties: { a: 1 } };
		const otherLang = { ...base, key: 'probe-lang', lang: 'lg-spa' };
		expect(contexts.fingerprintOf(sameAsBase)).toBe(contexts.fingerprintOf(base));
		for (const node of [otherView, otherGrouper, otherProperties, otherLang]) {
			expect(contexts.fingerprintOf(node)).not.toBe(contexts.fingerprintOf(base));
		}
	});
});

// ---------------------------------------------------------------------------
// W3 adversarial round 2: the section entry from stage 1, the governing view
// keys, the resolve_data frame node, the per-occurrence governing lang.
// ---------------------------------------------------------------------------

/** A section read of the host record with a client show AND search (stage 1). */
async function readHostWithShowAndSearch(
	show: Record<string, unknown>[],
	search: Record<string, unknown>[],
): Promise<{ ok: boolean; items: Item[]; context: ContextEntry[] }> {
	const body = (
		await dispatchRqo(
			{
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
					mode: 'list',
					lang: 'lg-nolan',
				},
				sqo: {
					section_tipo: [HOST],
					limit: 1,
					offset: 0,
					filter_by_locators: [{ section_tipo: HOST, section_id: String(HOST_ID) }],
				},
				show: { ddo_map: show },
				search: { ddo_map: search },
			} as never,
			tsContext as never,
		)
	).body as { ok?: boolean; data?: { data?: Item[]; context?: ContextEntry[] } };
	return {
		ok: body.ok !== false,
		items: (body.data?.data ?? []).filter((item) => item.typo !== 'sections'),
		context: body.data?.context ?? [],
	};
}

/** The stage-1 item of a context entry, typed loosely for the round-2 gates. */
type LooseConfigItem = {
	api_engine?: unknown;
	type?: unknown;
	show?: { ddo_map?: Record<string, unknown>[] };
	search?: { ddo_map?: Record<string, unknown>[] };
	sqo?: { limit?: unknown; section_tipo?: unknown[] };
};

describe('W3 adversarial round 2', () => {
	test('section door + client show: the section entry IS the stage-1 config (consolidated show, rqo search, rqo sqo)', async () => {
		const { ok, items, context } = await readHostWithShowAndSearch(
			[{ tipo: PORTAL_N, parent: 'self', section_tipo: 'self', mode: 'list', view: 'mini' }],
			[{ tipo: PORTAL_N, parent: 'self', section_tipo: 'self' }],
		);
		expect(ok).toBe(true);
		expect(items.some((item) => item.tipo === PORTAL_N)).toBe(true);
		const section = contextsOf(context, HOST, HOST)[0];
		expect(section).toBeDefined();
		const config = (section?.request_config ?? []) as unknown as LooseConfigItem[];
		// ONE dedalo main object (PHP build_request_config_from_rqo), nothing of the own config.
		expect(config).toHaveLength(1);
		expect(config[0]?.api_engine).toBe('dedalo');
		expect(config[0]?.type).toBe('main');
		// The consolidated CLIENT line: its view survives, 'self' resolved, label/mode filled.
		const line = config[0]?.show?.ddo_map?.[0];
		expect(config[0]?.show?.ddo_map).toHaveLength(1);
		expect(line?.tipo).toBe(PORTAL_N);
		expect(line?.view).toBe('mini');
		expect(line?.parent).toBe(HOST);
		expect(line?.section_tipo).toBe(HOST);
		expect(line?.mode).toBe('list');
		// rqo.search reaches the context; the sqo is the rqo's (its limit, its section).
		expect((config[0]?.search?.ddo_map ?? []).map((ddo) => ddo.tipo)).toEqual([PORTAL_N]);
		expect(config[0]?.sqo?.limit).toBe(1);
		expect(
			(config[0]?.sqo?.section_tipo ?? []).map((entry) =>
				typeof entry === 'string' ? entry : (entry as { tipo?: unknown }).tipo,
			),
		).toEqual([HOST]);
	});

	test('section door WITHOUT a client show: the section entry keeps its own config', async () => {
		const { ok, context } = await readSection(HOST, HOST_ID, 'list', null);
		expect(ok).toBe(true);
		const section = contextsOf(context, HOST, HOST)[0];
		expect(section).toBeDefined();
		// HOST declares no section_list / own config: its own request_config is
		// empty — NOT a stage-1 main item invented from the (absent) client show.
		expect(section?.request_config).toEqual([]);
	});

	for (const mode of ['edit', 'list'] as const) {
		test(`${mode}: a governing properties.view / children_view (no ddo.view) is the context view (PHP get_view on merged properties)`, async () => {
			const { ok, context } = await readSection(HOST, HOST_ID, mode, [
				{
					tipo: PORTAL_N,
					section_tipo: HOST,
					parent: HOST,
					mode,
					properties: { view: 'zz_governed_view', children_view: 'zz_governed_children' },
				},
			]);
			expect(ok).toBe(true);
			const entry = contextsOf(context, PORTAL_N, HOST)[0] as
				| (ContextEntry & { view?: unknown; children_view?: unknown })
				| undefined;
			expect(entry).toBeDefined();
			expect(entry?.view).toBe('zz_governed_view');
			expect(entry?.children_view).toBe('zz_governed_children');
		});
	}

	test('a ddo.view still wins over a governing properties.view', async () => {
		const { ok, context } = await readSection(HOST, HOST_ID, 'edit', [
			{
				tipo: PORTAL_N,
				section_tipo: HOST,
				parent: HOST,
				mode: 'edit',
				view: 'zz_ddo_view',
				properties: { view: 'zz_governed_view' },
			},
		]);
		expect(ok).toBe(true);
		const entry = contextsOf(context, PORTAL_N, HOST)[0] as
			| (ContextEntry & { view?: unknown })
			| undefined;
		expect(entry?.view).toBe('zz_ddo_view');
	});

	test('resolve_data with a dataframe child: the frame items are BOUND — the frame context is its node ([C], not own [PT]), no unbound warning', async () => {
		const warn = spyOn(console, 'warn');
		try {
			const body = (
				await dispatchRqo(
					{
						action: 'read',
						dd_api: 'dd_core_api',
						prevent_lock: true,
						source: {
							typo: 'source',
							type: 'component',
							model: 'component_portal',
							tipo: PORTAL_N,
							section_tipo: HOST,
							section_id: 'search_1',
							mode: 'search',
							lang: 'lg-nolan',
							action: 'resolve_data',
							value: [{ section_tipo: TARGET, section_id: 1, from_component_tipo: PORTAL_N }],
						},
						show: {
							ddo_map: [
								{ tipo: TEXT_B, parent: 'self', section_tipo: TARGET },
								{ tipo: FRAME_H, parent: 'self', section_tipo: HOST },
								{ tipo: TEXT_C, parent: FRAME_H, section_tipo: TARGET },
							],
						},
					} as never,
					tsContext as never,
				)
			).body as { ok?: boolean; data?: { context?: ContextEntry[]; data?: Item[] } };
			expect(body.ok).not.toBe(false);
			const data = body.data?.data ?? [];
			const context = body.data?.context ?? [];
			const frameItems = data.filter((item) => item.tipo === FRAME_H);
			expect(frameItems).toHaveLength(1);
			const frames = contextsOf(context, FRAME_H, HOST);
			expect(frames).toHaveLength(1);
			// the node's config: the caller line under FRAME_H ([C]) replaced its own [PT]
			expect(showOf(frames[0])).toEqual([TEXT_C]);
			expect(frames[0]?.mode).toBe('list');
			const unbound = warn.mock.calls.filter((call) =>
				String(call[0]).includes('has no element node'),
			);
			expect(unbound).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});

	test('(r) a frame with NO caller children: data children and page come from its built node — context show and sqo.limit equal what emits', async () => {
		const { ok, items, context, errorCode } = await readSection(HOST, HOST_ID, 'edit', [
			{ tipo: TEXT_LF, section_tipo: HOST, parent: HOST, mode: 'edit' },
		]);
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		const frame = items.find((item) => item.tipo === FRAME_FS) as
			| (Item & { pagination?: { limit?: unknown; total?: unknown; offset?: unknown } })
			| undefined;
		expect(frame).toBeDefined();
		// The built config (section_list swap in the frame's list mode): page 2, not
		// the raw own map's default 1.
		expect(frame?.pagination).toEqual({ total: 3, limit: 2, offset: 0 });
		expect(frame?.entries).toHaveLength(2);
		// Children [C] (the built show), at each paged target — never the raw own [A].
		const frameChildren = items.filter(
			(item) => item.from_component_tipo === FRAME_FS && item.section_tipo === TARGET,
		);
		expect(frameChildren.map((item) => item.tipo)).toEqual([TEXT_C, TEXT_C]);
		expect(frameChildren.map((item) => item.section_id)).toEqual([1, 2]);
		// The frame's CONTEXT is the same node: show == the emitted children, sqo.limit == the page.
		const frames = contextsOf(context, FRAME_FS, HOST);
		expect(frames).toHaveLength(1);
		expect(showOf(frames[0])).toEqual([TEXT_C]);
		expect(frames[0]?.request_config?.[0]?.sqo?.limit).toBe(2);
	});

	test('(b) governing LANG: a translatable child under two parents with different declared langs → two contexts, each cell lang == its context lang', async () => {
		const { ok, items, context } = await readSection(HOST, HOST_ID, 'edit', [
			{ tipo: PORTAL_N, section_tipo: HOST, parent: HOST, mode: 'edit' },
			{ tipo: TEXT_TR, section_tipo: TARGET, parent: PORTAL_N, mode: 'list', lang: 'lg-spa' },
			{ tipo: PORTAL_NH, section_tipo: HOST, parent: HOST, mode: 'edit' },
			{ tipo: TEXT_TR, section_tipo: TARGET, parent: PORTAL_NH, mode: 'list', lang: 'lg-eng' },
		]);
		expect(ok).toBe(true);
		const tr = contextsOf(context, TEXT_TR, TARGET) as (ContextEntry & { lang?: unknown })[];
		expect(tr).toHaveLength(2);
		const langByChain = new Map(tr.map((entry) => [entry.caller_chain, entry.lang]));
		expect(langByChain.get(PORTAL_N)).toBe('lg-spa');
		expect(langByChain.get(PORTAL_NH)).toBe('lg-eng');
		const cells = items.filter(
			(item) => item.tipo === TEXT_TR && item.section_tipo === TARGET,
		) as (Item & {
			lang?: unknown;
			caller_chain?: unknown;
		})[];
		expect(cells.length).toBeGreaterThan(0);
		for (const cell of cells) {
			expect(cell.lang).toBe(langByChain.get(cell.caller_chain as string));
		}
		expect(new Set(cells.map((cell) => cell.caller_chain))).toEqual(new Set([PORTAL_N, PORTAL_NH]));
	});
});
