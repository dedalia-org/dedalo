/**
 * PORTAL DESCENDANT MAP — a grandchild declared in the CALLER's ddo_map must
 * resolve, and the recursion that resolves it must be BOUNDED.
 *
 * THE BUG THIS PINS (2026-08-31, numisdata3 list): `relation_core.expandPortal`
 * recurses with `options.descendantsMap ?? childDdos`, and
 * `relations/models/portal.ts` set `descendantsMap` ONLY when the portal's
 * children were built from the component's own request_config. When the
 * children came from the CALLER's map instead, it passed `undefined` — so the
 * fallback handed each nested portal the portal's DIRECT children only, and
 * every level below the first was silently dropped. On the live install the
 * chain numisdata77 → numisdata164 → rsc29 (component_image) lost its rsc29
 * ddo: the server shipped rsc29 in `context` but no rsc29 item in `data`, the
 * client synthesised its "No data found for this component" stub with
 * entries:[], and every coin in the list rendered the placeholder image.
 *
 * The failure is invisible from the outside — a portal that emits its own item
 * and its direct children looks entirely healthy — so it is exactly the shape a
 * stray `?? childDdos` reintroduces in silence. Hence a gate.
 *
 * CONTRACTS:
 *  (a) A THREE-LEVEL caller map (portal → nested portal → leaf) emits the LEAF
 *      item, stamped from_component_tipo = the NESTED portal and row_section_id
 *      = the leaf's own target. Two levels below the section, from a map the
 *      client sent — the regression, expressed at its shortest. DISCRIMINATING
 *      since 2026-11-03: NESTED_PORTAL's own config shows a DIFFERENT field
 *      (LEAF_OTHER), so losing the caller's level-2 children (the old
 *      `?? childDdos` shape, or a broken injection) makes the own config win —
 *      LEAF_OTHER appears and LEAF_TEXT vanishes, and (a) goes red.
 *  (b) A FOUR-LEVEL caller map keeps going: depth is not the limit, the map is.
 *  (c) A TRUNCATED map (nested portal declared, leaf NOT) — CONTRACT INVERTED
 *      2026-11-03 (nested-ddo_map plan, owner-approved; plan Gates "give
 *      NESTED_PORTAL an own config and invert the contract"). The old pin said
 *      "in list mode a nested portal never falls back to its own config" —
 *      that was the TS-only `depth<4 && (edit || list&&ownConfig)` gate, which
 *      RELATIONS_SPEC rule 2 wrongly called PHP. PHP's get_subdatum resolves
 *      every element through ITS OWN effective config in every mode but
 *      'solved' (plan E2): a caller that names no children for an element
 *      leaves the element's own map standing. NESTED_PORTAL now has an own
 *      config showing LEAF_OTHER (a field no caller map here names), so the
 *      truncated map emits LEAF_OTHER through it and NOT LEAF_TEXT — and a
 *      caller that DOES name children still replaces it ((a)/(b)).
 *  (d) A CYCLIC map — CONTRACT CHANGED 2026-11-03 (same plan). The caller's
 *      children are now collected per element by the ancestor-path walk
 *      (relations/request_config/caller_injection.ts): `[{A,parent:section},
 *      {B,parent:A},{A,parent:B}]` gives A the children [B] and cuts the repeat
 *      A<B, so a cyclic MAP no longer recurses at all — the read COMPLETES and
 *      A appears once at the top. (Before, the whole flat map travelled down
 *      and only MAX_DDO_DEPTH's request.invalid_rqo ended it.) MAX_DDO_DEPTH
 *      stays the hard bound for what the map walk cannot see; a RECORD cycle
 *      is stopped by the per-path visited guard (nested_ddo_data_native).
 *
 * Engine under test: src/core/relations/models/portal.ts (descendantsMap),
 * src/core/relations/relation_core.ts (expandPortal's child recursion),
 * src/core/section/read.ts (emitDdoData + MAX_DDO_DEPTH).
 *
 * SITUATION (`zzcm`, scratch TLD, ids >= 900000): HOST —portal→ MID —portal→
 * LEAF —portal→ TAIL, one record at each level, one locator per hop. Dropped
 * in afterAll with residue asserted 0.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dispatchRqo } from '../../src/core/api/dispatch.ts';
import { resolvePrincipal } from '../../src/core/security/permissions.ts';
import { createSession, getSession } from '../../src/core/security/session_store.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';
import { registerSessionCleanup } from '../helpers/session_cleanup.ts';

registerSessionCleanup();

const HOST = 'zzcm1';
const PORTAL = 'zzcm2';
const MID = 'zzcm3';
const NESTED_PORTAL = 'zzcm4';
const LEAF = 'zzcm5';
/** The GRANDCHILD — two levels below the section, the item the bug lost. */
const LEAF_TEXT = 'zzcm6';
/** The field NESTED_PORTAL's OWN config shows — never named by a caller map here. */
const LEAF_OTHER = 'zzcm10';
const TAIL_PORTAL = 'zzcm7';
const TAIL = 'zzcm8';
const TAIL_TEXT = 'zzcm9';

const HOST_ID = 900601;
const MID_ID = 900602;
const LEAF_ID = 900603;
const TAIL_ID = 900604;

const LEAF_VALUE = 'the grandchild value';
const LEAF_OTHER_VALUE = 'the own-config value';
const TAIL_VALUE = 'the great-grandchild value';

/** One locator, the only shape any hop in this situation needs. */
const locator = (tipo: string, sectionTipo: string, sectionId: number) => [
	{
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: tipo,
	},
];

const S = situation({
	name: 'portal caller map descendants',
	tld: 'zzcm',
	nodes: [
		{ tipo: HOST, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		// (!) NO request_config on PORTAL: its children arrive ONLY from the
		// CALLER's map (an element with no own config takes the caller's
		// children as its config — relations/element_node.ts).
		{ tipo: PORTAL, parent: HOST, model: 'component_portal' },
		{ tipo: MID, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		// NESTED_PORTAL HAS an own config (contract (c)): it shows LEAF_OTHER. A
		// caller that names NESTED_PORTAL's children replaces that show map
		// ((a)/(b) — the injected children win); one that names none leaves it
		// standing ((c)).
		{
			tipo: NESTED_PORTAL,
			parent: MID,
			model: 'component_portal',
			properties: {
				source: {
					request_config: [
						{
							sqo: { section_tipo: [{ value: [LEAF], source: 'section' }] },
							show: {
								ddo_map: [{ tipo: LEAF_OTHER, parent: 'self', section_tipo: LEAF }],
							},
						},
					],
				},
			},
		},
		{ tipo: LEAF, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: LEAF_TEXT, parent: LEAF, model: 'component_input_text' },
		{ tipo: LEAF_OTHER, parent: LEAF, model: 'component_input_text', order_number: 3 },
		{ tipo: TAIL_PORTAL, parent: LEAF, model: 'component_portal', order_number: 2 },
		{ tipo: TAIL, parent: 'test1', model: 'section', relations: [{ tipo: 'test24' }] },
		{ tipo: TAIL_TEXT, parent: TAIL, model: 'component_input_text' },
	],
	records: [
		{
			section_tipo: HOST,
			section_id: HOST_ID,
			columns: { relation: { [PORTAL]: locator(PORTAL, MID, MID_ID) } },
		},
		{
			section_tipo: MID,
			section_id: MID_ID,
			columns: { relation: { [NESTED_PORTAL]: locator(NESTED_PORTAL, LEAF, LEAF_ID) } },
		},
		{
			section_tipo: LEAF,
			section_id: LEAF_ID,
			columns: {
				string: {
					[LEAF_TEXT]: [{ id: 1, lang: 'lg-nolan', value: LEAF_VALUE }],
					[LEAF_OTHER]: [{ id: 1, lang: 'lg-nolan', value: LEAF_OTHER_VALUE }],
				},
				relation: {
					[TAIL_PORTAL]: locator(TAIL_PORTAL, TAIL, TAIL_ID),
					// The back-edge contract (d) needs: LEAF —PORTAL→ MID closes
					// the loop, so every hop of the cyclic map WOULD find a
					// locator — the map walk's cut is what keeps it unreached.
					// Unreachable from every other map here, which never declares
					// PORTAL this deep.
					[PORTAL]: locator(PORTAL, MID, MID_ID),
				},
			},
		},
		{
			section_tipo: TAIL,
			section_id: TAIL_ID,
			columns: { string: { [TAIL_TEXT]: [{ id: 1, lang: 'lg-nolan', value: TAIL_VALUE }] } },
		},
	],
});

let tsContext: Record<string, unknown>;

beforeAll(async () => {
	await ensureSituation(S);
	const token = createSession(-1, 'root', true);
	const session = getSession(token);
	tsContext = {
		requestId: 'portal-caller-map-descendants',
		clientIp: '127.0.0.1',
		session,
		csrfCandidate: session?.csrfToken ?? null,
		principal: await resolvePrincipal(-1),
	};
}, 60000);

afterAll(async () => {
	expect(await dropSituation(S)).toBe(0);
});

interface Item {
	typo?: unknown;
	tipo?: unknown;
	section_tipo?: unknown;
	section_id?: unknown;
	from_component_tipo?: unknown;
	row_section_id?: unknown;
	entries?: unknown;
}

/** A LIST read of the host section through the real pipeline, with the given map. */
async function readWithMap(ddoMap: Record<string, unknown>[]): Promise<{
	ok: boolean;
	items: Item[];
	errorCode: string | null;
}> {
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
			mode: 'list',
			lang: 'lg-nolan',
		},
		sqo: { section_tipo: [HOST], limit: 1, offset: 0 },
		show: { ddo_map: ddoMap },
	};
	const body = (await dispatchRqo(structuredClone(rqo) as never, tsContext as never)).body as {
		ok?: boolean;
		data?: { data?: Item[] };
		error?: { code?: string };
	};
	return {
		ok: body.ok !== false,
		items: (body.data?.data ?? []).filter((item) => item.typo !== 'sections'),
		errorCode: body.error?.code ?? null,
	};
}

/** The map levels, as the client sends them (parent = the GENERATING ddo). */
const portalDdo = { tipo: PORTAL, section_tipo: HOST, parent: HOST, mode: 'list' };
const nestedDdo = { tipo: NESTED_PORTAL, section_tipo: MID, parent: PORTAL, mode: 'list' };
const leafDdo = { tipo: LEAF_TEXT, section_tipo: LEAF, parent: NESTED_PORTAL, mode: 'list' };
const tailPortalDdo = {
	tipo: TAIL_PORTAL,
	section_tipo: LEAF,
	parent: NESTED_PORTAL,
	mode: 'list',
};
const tailDdo = { tipo: TAIL_TEXT, section_tipo: TAIL, parent: TAIL_PORTAL, mode: 'list' };

const itemFor = (items: Item[], tipo: string): Item | undefined =>
	items.find((item) => item.tipo === tipo);

describe('portal caller-map descendants', () => {
	test('(a) a grandchild in the caller map resolves, stamped to its generating portal', async () => {
		const { ok, items } = await readWithMap([portalDdo, nestedDdo, leafDdo]);
		expect(ok).toBe(true);

		// Both portals emit their own item — that much was NEVER broken, and is
		// why the bug looked like a client fault.
		expect(itemFor(items, PORTAL)).toBeDefined();
		expect(itemFor(items, NESTED_PORTAL)).toBeDefined();

		// THE REGRESSION: the leaf, two levels down, from the caller's map.
		const leaf = itemFor(items, LEAF_TEXT);
		expect(leaf).toBeDefined();
		expect(leaf?.entries).toEqual([{ id: 1, lang: 'lg-nolan', value: LEAF_VALUE }]);
		// IDENTITY is the leaf's own record; GENERATOR is the nested portal.
		expect(leaf?.from_component_tipo).toBe(NESTED_PORTAL);
		expect(leaf?.section_tipo).toBe(LEAF);
		expect(leaf?.section_id).toBe(LEAF_ID);
		// row_section_id is the OUTER record, not the leaf's — every portal
		// descendant is re-stamped onto the row it hangs off in the section
		// read (relation_core's outer-subdatum re-stamp). Two levels down
		// changes nothing about that: the anchor stays the host row.
		expect(leaf?.row_section_id).toBe(HOST_ID);
		// DISCRIMINATION: the caller's level-2 children REPLACED the nested
		// portal's own show — its own field never renders.
		expect(itemFor(items, LEAF_OTHER)).toBeUndefined();
	});

	test('(b) a four-level map keeps resolving — the map is the limit, not the depth', async () => {
		const { ok, items } = await readWithMap([
			portalDdo,
			nestedDdo,
			leafDdo,
			tailPortalDdo,
			tailDdo,
		]);
		expect(ok).toBe(true);
		expect(itemFor(items, LEAF_TEXT)?.entries).toEqual([
			{ id: 1, lang: 'lg-nolan', value: LEAF_VALUE },
		]);
		const tail = itemFor(items, TAIL_TEXT);
		expect(tail?.entries).toEqual([{ id: 1, lang: 'lg-nolan', value: TAIL_VALUE }]);
		expect(tail?.from_component_tipo).toBe(TAIL_PORTAL);
		expect(tail?.section_id).toBe(TAIL_ID);
		expect(itemFor(items, LEAF_OTHER)).toBeUndefined();
	});

	test('(c) a truncated map: the nested portal falls back to its OWN config in list mode', async () => {
		// The nested portal is declared; its leaf is NOT. The caller names no
		// children for NESTED_PORTAL, so its own config stands (PHP get_subdatum,
		// plan E2) and the leaf resolves through it — in LIST mode, which the
		// retired gate refused.
		const { ok, items } = await readWithMap([portalDdo, nestedDdo]);
		expect(ok).toBe(true);
		expect(itemFor(items, NESTED_PORTAL)).toBeDefined();
		const own = itemFor(items, LEAF_OTHER);
		expect(own).toBeDefined();
		expect(own?.entries).toEqual([{ id: 1, lang: 'lg-nolan', value: LEAF_OTHER_VALUE }]);
		expect(own?.from_component_tipo).toBe(NESTED_PORTAL);
		// The caller-only field is NOT what the own config shows.
		expect(itemFor(items, LEAF_TEXT)).toBeUndefined();
	});

	test('(d) a cyclic map is cut at the repeat: the read completes', async () => {
		// PORTAL → NESTED_PORTAL → PORTAL: the caller-children walk cuts the
		// back-edge PORTAL<NESTED_PORTAL (it is on its own ancestor path), so
		// NESTED_PORTAL's injected children are empty and its OWN config governs
		// (LEAF_OTHER). LEAF's stored PORTAL locator is never reached: PORTAL is
		// not in anything NESTED_PORTAL resolves.
		const { ok, items, errorCode } = await readWithMap([
			portalDdo,
			nestedDdo,
			{ tipo: PORTAL, section_tipo: LEAF, parent: NESTED_PORTAL, mode: 'list' },
		]);
		expect(errorCode).toBeNull();
		expect(ok).toBe(true);
		expect(itemFor(items, NESTED_PORTAL)).toBeDefined();
		expect(itemFor(items, LEAF_OTHER)?.entries).toEqual([
			{ id: 1, lang: 'lg-nolan', value: LEAF_OTHER_VALUE },
		]);
		expect(itemFor(items, LEAF_TEXT)).toBeUndefined();
		// PORTAL emits ONCE — at the host — never again under NESTED_PORTAL.
		expect(items.filter((item) => item.tipo === PORTAL)).toHaveLength(1);
	}, 30000);
});
