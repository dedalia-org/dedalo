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
 *   4. DENY — THE AREAS DENY LAW (concepts/area.ts applyAreasDeny, owner ruling
 *      Q4 (b), WC-2026-11-22-areas-deny-subtree): a denied area hides itself
 *      AND its whole subtree at every depth — a denied ROOT and a denied child
 *      alike — and the menu and the permissions tree (security_access_datalist)
 *      answer IDENTICALLY; the root/admin/maintenance areas are never hidden
 *      (anti-lockout — a static AREAS_DENY is validated by no save).
 *   4b. ROOT PICK — a root is the FIRST node of its model in THE sibling order,
 *      in both walks (T2-SC-5b).
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
/** The denied node (depth 2 under the root) — dropped with its whole subtree. */
const DENIED = 'zzmenu9';
/** The denied node's child: hidden with it. */
const DENIED_CHILD = 'zzmenu10';
/** An area under the denied node … */
const DENIED_AREA_CHILD = 'zzmenu15';
/** … and a section under THAT (depth 4): hidden too — "at every depth". */
const DENIED_GRANDCHILD = 'zzmenu16';
/** The subtree hung under a deniable ROOT (the area_activity root, discovered). */
const ACT_AREA = 'zzmenu11';
const ACT_SECTION = 'zzmenu12';
const ACT_INNER_AREA = 'zzmenu13';
const ACT_INNER_SECTION = 'zzmenu14';
const ACT_SUBTREE = [ACT_AREA, ACT_SECTION, ACT_INNER_AREA, ACT_INNER_SECTION];

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
	DENIED_AREA_CHILD,
	DENIED_GRANDCHILD,
	...ACT_SUBTREE,
]);

const term = (english: string) => ({ 'lg-eng': english, 'lg-spa': `${english} (es)` });

/** Built in `beforeAll`, once the ambient root is known. */
const menuSituation = (root: string, activityRoot: string) =>
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
			{
				tipo: DENIED_AREA_CHILD,
				model: 'area',
				parent: DENIED,
				order_number: 2,
				term: term('Denied area child'),
			},
			{
				tipo: DENIED_GRANDCHILD,
				model: 'section',
				parent: DENIED_AREA_CHILD,
				order_number: 1,
				term: term('Denied grandchild'),
			},
			// under the deniable activity ROOT
			{
				tipo: ACT_AREA,
				model: 'area',
				parent: activityRoot,
				order_number: 9001,
				term: term('Activity area'),
			},
			{
				tipo: ACT_SECTION,
				model: 'section',
				parent: ACT_AREA,
				order_number: 1,
				term: term('Activity section'),
			},
			{
				tipo: ACT_INNER_AREA,
				model: 'area',
				parent: ACT_AREA,
				order_number: 2,
				term: term('Activity inner area'),
			},
			{
				tipo: ACT_INNER_SECTION,
				model: 'section',
				parent: ACT_INNER_AREA,
				order_number: 1,
				term: term('Activity inner section'),
			},
		],
	});

let MENU_SITUATION = menuSituation('dd1', 'dd1');
/** The area_activity root (deniable: not a guarded model). */
let ACTIVITY_ROOT = '';

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
/** The deny / skip this file states on top of the deployment's own. */
let baseDeny: string[] = [];
let baseSkip: string[] = [];

async function readMenu(): Promise<MenuItem[]> {
	// The walk memoizes its bulk ontology read; this file writes ontology, so the
	// derived caches are dropped before every read.
	await clearOntologyDerivedCaches();
	const { tree_datalist } = await getMenuTreeDatalist(SUPERUSER);
	return tree_datalist as unknown as MenuItem[];
}

/** The permissions tree's tipos (the superuser = unfiltered datalist). */
async function readPermissionsTree(): Promise<Set<string>> {
	await clearOntologyDerivedCaches();
	return new Set((await getSecurityAccessDatalist(SUPERUSER)).map((item) => item.tipo));
}

/** Menu + permissions tree under `extraDeny` on top of this file's deny; state restored after. */
async function readBothWith(
	extraDeny: readonly string[],
): Promise<{ menu: Set<string>; tree: Set<string> }> {
	setServerState({ areas_deny: [...baseDeny, ...extraDeny], menu_skip_tipos: baseSkip });
	try {
		const menu = new Set((await readMenu()).map((item) => item.tipo));
		return { menu, tree: await readPermissionsTree() };
	} finally {
		setServerState({ areas_deny: baseDeny, menu_skip_tipos: baseSkip });
		await clearOntologyDerivedCaches();
	}
}

beforeAll(async () => {
	// Discover the root this database actually has, then build under it.
	const { sql } = await import('../../src/core/db/postgres.ts');
	const rootRows = (await sql`
		SELECT tipo FROM dd_ontology WHERE model = 'area_root' ORDER BY id LIMIT 1
	`) as { tipo: string }[];
	ROOT = rootRows[0]?.tipo ?? '';
	expect(ROOT, 'this ontology declares no area_root — the menu has no tree to walk').not.toBe('');
	const activityRows = (await sql`
		SELECT tipo FROM dd_ontology WHERE model = 'area_activity'
		ORDER BY order_number ASC NULLS LAST, tipo COLLATE "C" ASC LIMIT 1
	`) as { tipo: string }[];
	ACTIVITY_ROOT = activityRows[0]?.tipo ?? '';
	expect(ACTIVITY_ROOT, 'this ontology declares no area_activity root').not.toBe('');
	MENU_SITUATION = menuSituation(ROOT, ACTIVITY_ROOT);
	await ensureSituation(MENU_SITUATION);
	const before = getServerState();
	restoreState = {
		areas_deny: before.areas_deny === null ? null : [...before.areas_deny],
		menu_skip_tipos: before.menu_skip_tipos === null ? null : [...before.menu_skip_tipos],
	};
	// Deny and skip are RUNTIME state, so the gate can state them instead of
	// depending on whatever this deployment configured.
	baseDeny = [...(before.areas_deny ?? []), DENIED];
	baseSkip = [...(before.menu_skip_tipos ?? []), SKIPPED_WRAPPER];
	setServerState({ areas_deny: baseDeny, menu_skip_tipos: baseSkip });
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
		// Four plus the activity subtree of the fifteen built nodes are emitted;
		// the rest are the point of the filter/deny/skip laws below.
		expect(emitted.map((item) => item.tipo).sort()).toEqual(
			[AREA_A, AREA_B, SECTION_A, REPARENTED, ...ACT_SUBTREE].sort(),
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

	test('DENY: the named node goes WITH its whole subtree, at every depth', () => {
		const tipos = emitted.map((item) => item.tipo);
		for (const hidden of [DENIED, DENIED_CHILD, DENIED_AREA_CHILD, DENIED_GRANDCHILD]) {
			expect(tipos).not.toContain(hidden);
		}
		// non-vacuity: the denied node's sibling branch (B's skip child) stays
		expect(tipos).toContain(REPARENTED);
	});

	test('DENY: the menu and the permissions tree answer IDENTICALLY (one applyAreasDeny)', async () => {
		const tree = await readPermissionsTree();
		const menu = new Set(emitted.map((item) => item.tipo));
		// every built area/section the walk reaches: in the menu iff in the tree.
		// (the skip wrapper is a MENU transform only; the non-menu models are
		// never walked by either.)
		const comparable = [...OURS].filter(
			(tipo) => tipo !== SKIPPED_WRAPPER && tipo !== NOT_A_MENU_MODEL && tipo !== BEHIND_THE_WALL,
		);
		const disagreements = comparable.filter((tipo) => menu.has(tipo) !== tree.has(tipo));
		expect(disagreements).toEqual([]);
		// non-vacuity on both sides of the law
		expect(tree.has(DENIED_GRANDCHILD)).toBe(false);
		expect(tree.has(AREA_A)).toBe(true);
	});

	test('DENY a ROOT: the root and its subtree at every depth go, from both', async () => {
		const { menu, tree } = await readBothWith([ACTIVITY_ROOT]);
		for (const hidden of [ACTIVITY_ROOT, ...ACT_SUBTREE]) {
			expect(menu.has(hidden), `menu still offers ${hidden}`).toBe(false);
			expect(tree.has(hidden), `permissions tree still lists ${hidden}`).toBe(false);
		}
		// and back: the state was the deny, not a broken walk
		const after = await readBothWith([]);
		for (const tipo of [ACTIVITY_ROOT, ...ACT_SUBTREE]) expect(after.tree.has(tipo)).toBe(true);
		for (const tipo of ACT_SUBTREE) expect(after.menu.has(tipo)).toBe(true);
	});

	test('ANTI-LOCKOUT: a deny list naming the guarded areas (a static AREAS_DENY is validated by no save) hides none of them', async () => {
		const { sql } = await import('../../src/core/db/postgres.ts');
		const guarded = (
			(await sql`
				SELECT tipo FROM dd_ontology WHERE model IN ('area_root', 'area_maintenance', 'area_admin')
			`) as { tipo: string }[]
		).map((row) => row.tipo);
		expect(guarded.length).toBeGreaterThanOrEqual(3);
		const { menu, tree } = await readBothWith(guarded);
		// the root (and what hangs under it), the admin and maintenance roots stay
		expect(tree.has(ROOT)).toBe(true);
		expect(menu.has(ROOT)).toBe(true);
		expect(menu.has(AREA_A)).toBe(true);
		for (const tipo of guarded.filter((t) => t === 'dd88' || t === 'dd207')) {
			expect(tree.has(tipo), `guarded ${tipo} hidden`).toBe(true);
		}
	});

	test('SKIP: the wrapper goes and its child is RE-PARENTED to the first surviving ancestor', () => {
		const tipos = emitted.map((item) => item.tipo);
		expect(tipos).not.toContain(SKIPPED_WRAPPER);
		const reparented = emitted.find((item) => item.tipo === REPARENTED);
		expect(reparented).toBeDefined();
		// NOT the skipped wrapper it is stored under — the ancestor that survived.
		expect(reparented?.parent).toBe(AREA_B);
	});

	test('DENY leaves no orphan — every emitted item of ours hangs off an emitted parent', () => {
		// The old rule kept a denied node's child with the stored parent of a node
		// no longer in the list (an unattachable entry). The subtree rule removes
		// the branch whole, so every parent below the root resolves.
		const listed = new Set(fullList.map((item) => item.tipo));
		for (const item of emitted) {
			expect(item.parent === null || listed.has(item.parent), `${item.tipo} orphaned`).toBe(true);
		}
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
		expect(order.indexOf(REPARENTED)).toBeGreaterThan(-1);
		expect(order.indexOf(REPARENTED)).toBeLessThan(order.indexOf(AREA_A));
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

	test('ROOT PICK (T2-SC-5b): two nodes of a root model → BOTH walks pick the first in sibling order', async () => {
		// A second `area_graph` (the dead root nobody navigates) with the LOWER
		// order_number, written AFTER the seed's (so heap / id order answers the
		// seed's). Built and dropped inside this test.
		const dup = situation({
			tld: 'zzmdup',
			name: 'menu duplicate root model',
			nodes: [{ tipo: 'zzmdup1', model: 'area_graph', parent: ONTOLOGY_ROOT, order_number: 0 }],
		});
		const seedGraph = (await collectAreaRows()).find((row) => row.model === 'area_graph')?.tipo;
		expect(seedGraph, 'the seed ships an area_graph root').toBeDefined();
		await ensureSituation(dup);
		try {
			await clearOntologyDerivedCaches();
			const walkRoot = (await collectAreaRows()).find((row) => row.model === 'area_graph')?.tipo;
			const tree = await readPermissionsTree();
			expect(walkRoot).toBe('zzmdup1');
			expect(tree.has('zzmdup1')).toBe(true);
			expect(tree.has(seedGraph as string)).toBe(false);
		} finally {
			expect(await dropSituation(dup)).toBe(0);
			await clearOntologyDerivedCaches();
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
