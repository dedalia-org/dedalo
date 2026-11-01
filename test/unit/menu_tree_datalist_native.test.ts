/**
 * MENU TREE_DATALIST — the walk's LAWS, on a built ontology (TS-native).
 *
 * WHY THIS GATE EXISTS. `test/parity/menu_differential.test.ts` compares the
 * whole menu against the frozen PHP body, and it CANNOT be migrated to the
 * generic `test` TLD: the superuser menu is an unfiltered `area::get_areas()`
 * walk, so the frozen body names every area of the harvested installation —
 * 107 install tokens across ~30 TLDs survive `adoptTipoIdMap`, because the
 * clone was cut at the SECTION root of 33 subtrees and by design holds no twin
 * of an install's complete area tree. That gate therefore stays as the frozen
 * record of the PHP walk, and this file is its portable half: the RULES the
 * walk obeys, stated over an ontology this file builds and can therefore
 * assert exactly.
 *
 * WHAT IT PINS (src/core/api/handlers/menu.ts, PHP menu::get_tree_datalist +
 * area::get_areas):
 *   1. ROOT ORDER — roots appear in MENU_ROOT_MODEL_ORDER, not ontology order.
 *   2. SIBLING ORDER — children walk depth-first pre-order by `order_number`.
 *   3. MODEL FILTER — only area/section/section_tool are kept, and recursion
 *      descends ONLY into kept nodes (a section_list child is not a doorway).
 *   4. DENY — removes the named node but KEEPS its descendants, re-parented by
 *      the skip rule below (PHP checks deny when ADDING, never when recursing).
 *   5. SKIP — a skipped wrapper is dropped and its children are re-parented to
 *      the first non-skipped ancestor.
 *   6. LABEL — resolved from the ontology `term` map in the application
 *      language.
 *
 * SCOPE. The walk reads the WHOLE ontology, so this gate never asserts the full
 * result: it filters the emitted list to its own `zzmenu` subtree and asserts
 * that subtree exactly. Anything the ambient ontology contributes is another
 * installation's business, and asserting it is what made the frozen gate
 * unportable in the first place.
 *
 * Environment: suite DB. Every node is built here (reserved `zzmenu` scratch
 * TLD, situations/situation.ts) and dropped whole in afterAll with the residue
 * ASSERTED. The runtime deny/skip lists are set through `setServerState` and
 * restored, so the gate never depends on — or leaves behind — a config edit.
 *
 * @twin-of      test/parity/menu_differential.test.ts
 * @twin-status  frozen-record
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { config } from '../../src/config/config.ts';
import {
	collectAreaRows,
	getAllAreas,
	getMenuTreeDatalist,
} from '../../src/core/api/handlers/menu.ts';
import {
	areaBehaviorOf,
	isAreaModel,
	MENU_ROOT_MODEL_ORDER,
} from '../../src/core/concepts/area.ts';
import { clearOntologyDerivedCaches } from '../../src/core/ontology/cache_invalidation.ts';
import { getSecurityAccessDatalist } from '../../src/core/resolve/security_access_datalist.ts';
import { getServerState, setServerState } from '../../src/core/resolve/server_state.ts';
import {
	dropSituation,
	ensureSituation,
	situation,
} from '../../src/core/test_data/situations/situation.ts';

/**
 * The root this file HANGS OFF — discovered, not built. Area roots are
 * SINGLETONS picked by model (`rows.find(row => row.model === rootModel)`), so a
 * built situation cannot introduce one: the ambient ontology already owns every
 * root model, and its row wins. The laws under test are about what happens
 * BELOW a root — order, model filter, deny, skip — so the fixture attaches its
 * subtree to whichever `area_root` this database has, and asserts only its own
 * nodes.
 */
let ROOT = '';
/** Ordinary child area — kept, and a doorway. */
const AREA_A = 'zzmenu2';
/** Second child area, deliberately given the LOWER order_number. */
const AREA_B = 'zzmenu3';
/** A section under AREA_A — kept. */
const SECTION_A = 'zzmenu4';
/** A `section_list` child: NOT a menu model, and not a doorway either. */
const NOT_A_MENU_MODEL = 'zzmenu5';
/** A section parented to the section_list — unreachable, because recursion never descends into a dropped model. */
const BEHIND_THE_WALL = 'zzmenu6';
/** The wrapper the skip rule hides. */
const SKIPPED_WRAPPER = 'zzmenu7';
/** Its child, which must survive and be RE-PARENTED to AREA_B. */
const REPARENTED = 'zzmenu8';
/** The denied node — dropped itself, while its child survives. */
const DENIED = 'zzmenu9';
/** The denied node's child: must still be emitted. */
const DENIED_CHILD = 'zzmenu10';

const OURS = new Set([
	AREA_A,
	AREA_B,
	SECTION_A,
	NOT_A_MENU_MODEL,
	BEHIND_THE_WALL,
	SKIPPED_WRAPPER,
	REPARENTED,
	DENIED,
	DENIED_CHILD,
]);

const term = (english: string) => ({ 'lg-eng': english, 'lg-spa': `${english} (es)` });

/** Built in `beforeAll`, once the ambient root is known. */
const menuSituation = (root: string) =>
	situation({
		tld: 'zzmenu',
		name: 'menu tree_datalist walk',
		nodes: [
			// order_number decides sibling order, NOT the order they are declared in
			// here — B is declared second and must come FIRST. High numbers keep the
			// pair AFTER whatever the ambient root already carries.
			{ tipo: AREA_A, model: 'area', parent: root, order_number: 9002, term: term('Area A') },
			{ tipo: AREA_B, model: 'area', parent: root, order_number: 9001, term: term('Area B') },
			{
				tipo: SECTION_A,
				model: 'section',
				parent: AREA_A,
				order_number: 1,
				term: term('Section A'),
			},
			{
				tipo: NOT_A_MENU_MODEL,
				model: 'section_list',
				parent: AREA_A,
				order_number: 2,
				term: term('Not a menu model'),
			},
			{
				tipo: BEHIND_THE_WALL,
				model: 'section',
				parent: NOT_A_MENU_MODEL,
				order_number: 1,
				term: term('Behind the wall'),
			},
			{
				tipo: SKIPPED_WRAPPER,
				model: 'area',
				parent: AREA_B,
				order_number: 1,
				term: term('Skipped wrapper'),
			},
			{
				tipo: REPARENTED,
				model: 'section',
				parent: SKIPPED_WRAPPER,
				order_number: 1,
				term: term('Reparented'),
			},
			{ tipo: DENIED, model: 'area', parent: AREA_B, order_number: 2, term: term('Denied') },
			{
				tipo: DENIED_CHILD,
				model: 'section',
				parent: DENIED,
				order_number: 1,
				term: term('Denied child'),
			},
		],
	});

let MENU_SITUATION = menuSituation('dd1');

/** The ontology root every area root is parented to (seed-shipped, install-invariant). */
const ONTOLOGY_ROOT = 'dd1';

const SUPERUSER = { userId: -1, isGlobalAdmin: true, isDeveloper: true };

interface MenuItem {
	tipo: string;
	model: string;
	parent: string | null;
	label: string;
}

let emitted: MenuItem[] = [];
let fullList: MenuItem[] = [];
let restoreState: { areas_deny: string[] | null; menu_skip_tipos: string[] | null };

async function readMenu(): Promise<MenuItem[]> {
	// The walk memoizes its bulk ontology read; this file writes ontology, so the
	// derived caches are dropped before every read.
	await clearOntologyDerivedCaches();
	const { tree_datalist } = await getMenuTreeDatalist(SUPERUSER);
	return tree_datalist as unknown as MenuItem[];
}

beforeAll(async () => {
	// Discover the root this database actually has, then build under it.
	const { sql } = await import('../../src/core/db/postgres.ts');
	const rootRows = (await sql`
		SELECT tipo FROM dd_ontology WHERE model = 'area_root' ORDER BY id LIMIT 1
	`) as { tipo: string }[];
	ROOT = rootRows[0]?.tipo ?? '';
	expect(ROOT, 'this ontology declares no area_root — the menu has no tree to walk').not.toBe('');
	MENU_SITUATION = menuSituation(ROOT);
	await ensureSituation(MENU_SITUATION);
	const before = getServerState();
	restoreState = {
		areas_deny: before.areas_deny === null ? null : [...before.areas_deny],
		menu_skip_tipos: before.menu_skip_tipos === null ? null : [...before.menu_skip_tipos],
	};
	// Deny and skip are RUNTIME state, so the gate can state them instead of
	// depending on whatever this deployment configured.
	setServerState({
		areas_deny: [...(before.areas_deny ?? []), DENIED],
		menu_skip_tipos: [...(before.menu_skip_tipos ?? []), SKIPPED_WRAPPER],
	});
	fullList = await readMenu();
	emitted = fullList.filter((item) => OURS.has(item.tipo));
});

afterAll(async () => {
	setServerState(restoreState);
	await clearOntologyDerivedCaches();
	// Residue asserted, not trusted.
	expect(await dropSituation(MENU_SITUATION)).toBe(0);
});

describe('menu tree_datalist — the walk laws (built ontology)', () => {
	test('ANTI-VACUITY: the built subtree really is in the menu', () => {
		expect(fullList.length).toBeGreaterThan(0);
		// Five of the nine built nodes are emitted; the other four are the point of
		// the filter/deny/skip laws below.
		expect(emitted.map((item) => item.tipo).sort()).toEqual(
			[AREA_A, AREA_B, SECTION_A, REPARENTED, DENIED_CHILD].sort(),
		);
	});

	test('MODEL FILTER: a non-menu model is dropped AND is not a doorway', () => {
		const tipos = emitted.map((item) => item.tipo);
		expect(tipos).not.toContain(NOT_A_MENU_MODEL);
		// The section BEHIND it is a perfectly good menu model, and still absent:
		// recursion descends only into kept nodes. A walk that filtered on output
		// but recursed on everything would emit it.
		expect(tipos).not.toContain(BEHIND_THE_WALL);
	});

	test('DENY: the named node goes, its descendants stay', () => {
		const tipos = emitted.map((item) => item.tipo);
		expect(tipos).not.toContain(DENIED);
		expect(tipos).toContain(DENIED_CHILD);
	});

	test('SKIP: the wrapper goes and its child is RE-PARENTED to the first surviving ancestor', () => {
		const tipos = emitted.map((item) => item.tipo);
		expect(tipos).not.toContain(SKIPPED_WRAPPER);
		const reparented = emitted.find((item) => item.tipo === REPARENTED);
		expect(reparented).toBeDefined();
		// NOT the skipped wrapper it is stored under — the ancestor that survived.
		expect(reparented?.parent).toBe(AREA_B);
	});

	test('DENY does NOT re-parent — only SKIP does (measured 2026-08-20)', () => {
		// The two drop rules are NOT the same rule, and this is the difference.
		// SKIP re-parents its orphans (asserted above); DENY does not: the child
		// keeps the stored parent of a node that is no longer in the list, so the
		// client cannot attach it and the branch simply does not render.
		//
		// PHP behaves the same way — deny is checked when ADDING a node, never
		// when recursing, and the menu transform re-parents only across SKIPPED
		// ancestors. Pinned as behaviour, not endorsed as a design: a caller that
		// assumed every `parent` resolves to an emitted item would be wrong here.
		const child = emitted.find((item) => item.tipo === DENIED_CHILD);
		expect(child).toBeDefined();
		expect(child?.parent).toBe(DENIED);
		expect(emitted.some((item) => item.tipo === DENIED)).toBe(false);
	});

	test('SIBLING ORDER: children follow order_number, not declaration or id order', () => {
		const order = emitted.map((item) => item.tipo);
		// B (order_number 1) precedes A (order_number 2), though A is declared —
		// and inserted — first.
		expect(order.indexOf(AREA_B)).toBeLessThan(order.indexOf(AREA_A));
		expect(order.indexOf(AREA_B)).toBeGreaterThan(order.indexOf(ROOT));
	});

	test('DEPTH-FIRST PRE-ORDER: a node is followed by its own subtree before its sibling', () => {
		const order = emitted.map((item) => item.tipo);
		// B's subtree (REPARENTED, DENIED_CHILD) lands before A, its later sibling.
		expect(order.indexOf(REPARENTED)).toBeLessThan(order.indexOf(AREA_A));
		expect(order.indexOf(DENIED_CHILD)).toBeLessThan(order.indexOf(AREA_A));
		// and A's own child follows A.
		expect(order.indexOf(SECTION_A)).toBeGreaterThan(order.indexOf(AREA_A));
	});

	test('ROOT ORDER: roots appear in MENU_ROOT_MODEL_ORDER, whatever the ontology holds', () => {
		// A root's `parent` is the ONTOLOGY ROOT (`dd1`), never null — the menu is
		// flat and encodes the tree through `parent`.
		const rootModels = fullList
			.filter((item) => item.parent === ONTOLOGY_ROOT)
			.map((item) => item.model)
			.filter((model) => MENU_ROOT_MODEL_ORDER.includes(model));
		const ranks = rootModels.map((model) => MENU_ROOT_MODEL_ORDER.indexOf(model));
		expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
		// Not vacuous: this ontology declares several roots, and the one this
		// fixture hangs off is among them.
		expect(rootModels.length).toBeGreaterThan(1);
		expect(fullList.some((item) => item.tipo === ROOT)).toBe(true);
	});

	test('LABEL: resolved from the ontology term map in the APPLICATION language', () => {
		// Not hard-coded to English: the label follows this deployment's
		// application language, which is exactly the law under test. The fixture
		// declares a different string per language so the two cannot be confused.
		const section = emitted.find((item) => item.tipo === SECTION_A);
		const appLang = config.menu.applicationLang;
		const expected = term('Section A')[appLang as keyof ReturnType<typeof term>];
		expect(expected, `the fixture declares no term for '${appLang}'`).toBeDefined();
		expect(section?.label).toBe(expected as string);
	});

	test('DEAD AREA: a behaviorless area model is walked but never offered (WC-2026-11-01-menu-dead-area)', async () => {
		// The read refuses an area model with no behavior resolver (area_graph), so
		// a menu entry for it is a dead link. The walk keeps it; the menu drops and
		// records it.
		const dead = (await collectAreaRows())
			.filter((row) => isAreaModel(row.model) && areaBehaviorOf(row.model) === null)
			.map((row) => row.tipo);
		// Not vacuous: the core seed ships area_graph (dd630) as a root.
		expect(dead.length).toBeGreaterThan(0);
		const { tree_datalist, skipped } = await getMenuTreeDatalist(SUPERUSER);
		const offered = new Set(tree_datalist.map((item) => item.tipo));
		const recorded = new Set(skipped.map((entry) => entry.tipo));
		for (const tipo of dead) {
			expect(offered.has(tipo)).toBe(false);
			expect(recorded.has(tipo)).toBe(true);
		}
		expect(
			tree_datalist.some((item) => isAreaModel(item.model) && areaBehaviorOf(item.model) === null),
		).toBe(false);
		// The OTHER half of the contract: only the menu drops it. The area-visibility
		// catalog (getAllAreas → config_areas / menu_skip_tipos) and the profile
		// permissions datalist must still list it, so it stays deniable/grantable.
		const catalog = new Set((await getAllAreas()).map((row) => row.tipo));
		const permissions = new Set(
			(await getSecurityAccessDatalist(SUPERUSER)).map((item) => item.tipo),
		);
		for (const tipo of dead) {
			expect(catalog.has(tipo)).toBe(true);
			expect(permissions.has(tipo)).toBe(true);
		}
	});

	test('SHAPE: every item carries exactly {tipo, model, parent, label}', () => {
		for (const item of emitted) {
			expect(Object.keys(item).sort()).toEqual(['label', 'model', 'parent', 'tipo']);
			expect(typeof item.tipo).toBe('string');
			expect(typeof item.model).toBe('string');
			expect(typeof item.label).toBe('string');
		}
	});
});
