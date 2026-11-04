/**
 * STAGE 1 — buildRequestConfigFromRqo (src/core/relations/request_config/from_rqo.ts),
 * the port of PHP build_request_config_from_rqo + validate_requested_ddo +
 * consolidate_requested_ddo (frozen class.common.php :3056-3131, :3325-3404).
 *
 * Situation: the suite's own `test` TLD (test3 playground section, its
 * component_publication test92 and component_select test91), the synthetic
 * ACL identities of test/helpers/acl_identity_fixture.ts (built here, swept
 * after): the non-admin reads test3 + test92 and is granted NOTHING on test91
 * (nor on test92 in any other section, e.g. test38).
 * Nothing is read from records; only ontology rows and the fixture's grants.
 *
 * The installed-TLD branch cannot be BUILT: dd_ontology's identifier grammar
 * (SURF-1, tipo_in_tld) refuses a row whose tipo does not sit in its own TLD,
 * so "a model resolves but its TLD has no row" is a cache/race state, never a
 * fixture. That one case narrows the installed-TLD set for its own duration
 * (`spyOn` on dd_ontology's getActiveTlds, restored in `finally`) and pins the
 * control on the same ddo with the real set.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { CLIENT_MAX_LIMIT } from '../../src/core/concepts/sqo.ts';
import * as ddOntology from '../../src/core/db/dd_ontology.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { getModelByTipo } from '../../src/core/ontology/resolver.ts';
import {
	CLIENT_SOURCE_ARRAY_MAX,
	isActiveTldTipo,
} from '../../src/core/relations/request_config/explicit.ts';
import {
	buildRequestConfigFromRqo,
	type InheritedDdo,
	type RqoElement,
} from '../../src/core/relations/request_config/from_rqo.ts';
import { runWithRequestLangs } from '../../src/core/resolve/request_lang.ts';
import { type Principal, resolvePrincipal } from '../../src/core/security/permissions.ts';
import {
	ACL_DENIED_COMPONENT,
	ACL_GRANTED_COMPONENT,
	ACL_GRANTED_SECTION,
	ACL_NON_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';

const SECTION = ACL_GRANTED_SECTION; // test3
const GRANTED = ACL_GRANTED_COMPONENT; // test92
const DENIED = ACL_DENIED_COMPONENT; // test91
/** A tipo of the right grammar that no ontology row resolves. */
const UNRESOLVABLE = 'test999999991';
/** A section the non-admin holds NO grant in (test92 there is unreadable to it). */
const OTHER_SECTION = 'test38';

// DB reachability probe (the suite convention): only a genuinely unreachable
// DB downgrades this DB-backed gate to a visible SKIP.
let dbReady = false;
try {
	await sql`SELECT 1`;
	dbReady = true;
} catch {
	console.warn('[request_config_from_rqo] DB unavailable — stage-1 gate SKIPPED');
}
let nonAdmin: Principal;
let root: Principal;

beforeAll(async () => {
	if (!dbReady) return;
	await installAclIdentityFixture();
	nonAdmin = await resolvePrincipal(ACL_NON_ADMIN_USER_ID);
	root = await resolvePrincipal(-1);
});

afterAll(async () => {
	if (!dbReady) return;
	await removeAclIdentityFixture();
});

const sectionElement: RqoElement = { kind: 'section', tipo: SECTION, mode: 'list' };
const withLangs = <T>(fn: () => Promise<T>): Promise<T> =>
	runWithRequestLangs({ applicationLang: 'lg-eng', dataLang: 'lg-eng' }, fn);
const build = (rqo: unknown, element: RqoElement = sectionElement, principal?: Principal) =>
	withLangs(() => buildRequestConfigFromRqo(rqo, element, principal));
/** A component element: test80 living in test3, pointing at test3. */
const COMPONENT = 'test80';
const componentElement = (inheritedDdos: InheritedDdo[] = []): RqoElement => ({
	kind: 'component',
	tipo: COMPONENT,
	mode: 'list',
	sectionTipo: SECTION,
	targetSectionTipos: [SECTION],
	inheritedDdos,
});
/** The suite's component_dataframe (test60) — frames live on the OWNER record. */
const DATAFRAME = 'test60';
/** A component in test3 whose targets are test38 — owner ≠ target, so the dataframe rule shows. */
const foreignTargetElement: RqoElement = {
	kind: 'component',
	tipo: COMPONENT,
	mode: 'list',
	sectionTipo: SECTION,
	targetSectionTipos: [OTHER_SECTION],
	inheritedDdos: [],
};
/** The four spellings of 'self' (self_depth.ts module header). */
const SELF_SPELLINGS: unknown[] = [
	'self',
	['self'],
	[{ source: 'self' }],
	[{ source: 'section', value: ['self'] }],
];
const child = (tipo: string, extra: Record<string, unknown> = {}) => ({
	tipo,
	parent: 'self',
	section_tipo: 'self',
	...extra,
});

describe.if(dbReady)('buildRequestConfigFromRqo — stage 1', () => {
	test('preconditions: the situation exists (anti-vacuity)', async () => {
		expect(dbReady).toBe(true);
		const rows = (await sql`
			SELECT tipo, model FROM dd_ontology WHERE tipo IN (${SECTION}, ${GRANTED}, ${DENIED}, ${DATAFRAME})
		`) as { tipo: string; model: string }[];
		expect(rows).toHaveLength(4);
		expect(rows.find((row) => row.tipo === DATAFRAME)?.model).toBe('component_dataframe');
		expect((await sql`SELECT 1 FROM dd_ontology WHERE tipo = ${UNRESOLVABLE}`).length).toBe(0);
	});

	test('gate: the rqo must target the element (source.tipo, or the element in sqo.section_tipo)', async () => {
		const show = { ddo_map: [child(GRANTED)] };
		expect(await build({ source: { tipo: SECTION }, show })).not.toBeNull();
		expect(await build({ source: { tipo: 'test38' }, show })).toBeNull();
		expect(
			await build({ source: { tipo: 'test38' }, sqo: { section_tipo: [SECTION] }, show }),
		).not.toBeNull();
		expect(await build({ show })).toBeNull(); // no source at all
	});

	test('show gate is PHP-exact: absent → null; an object with an empty or no ddo_map still builds the item', async () => {
		// PHP `empty($rqo->show)` on a decoded stdClass is false for ANY object.
		expect(await build({ source: { tipo: SECTION } })).toBeNull();
		expect(await build({ source: { tipo: SECTION }, show: null })).toBeNull();
		expect(await build({ source: { tipo: SECTION }, show: [] })).toBeNull();
		const emptyMap = await build({
			source: { tipo: SECTION },
			show: { ddo_map: [] },
			sqo: { section_tipo: [SECTION], limit: 5 },
		});
		expect(emptyMap).toHaveLength(1);
		expect(emptyMap?.[0]?.show).toEqual({ ddo_map: [] });
		// the client sqo governs the read (zero columns, the client's page)
		expect(emptyMap?.[0]?.sqo?.limit).toBe(5);
		const noMap = await build({ source: { tipo: SECTION }, show: { sqo_config: { limit: 5 } } });
		expect(noMap?.[0]?.show).toEqual({ ddo_map: [] });
	});

	test('ONE {dedalo, main, show} item; only ddo_map copied — sqo_config / choose / hide ignored', async () => {
		const config = await build({
			source: { tipo: SECTION },
			show: { ddo_map: [child(GRANTED)], sqo_config: { limit: 999_999_999 } },
			search: { ddo_map: [child(GRANTED)], sqo_config: { limit: 999_999_999 } },
			choose: { ddo_map: [child(GRANTED)] },
		});
		expect(config).toHaveLength(1);
		const item = config?.[0];
		expect(item?.api_engine).toBe('dedalo');
		expect(item?.type).toBe('main');
		expect(Object.keys(item?.show ?? {})).toEqual(['ddo_map']);
		expect(Object.keys(item?.search ?? {})).toEqual(['ddo_map']);
		expect(Object.keys(item ?? {}).sort()).toEqual(['api_engine', 'search', 'show', 'type']);
	});

	test('consolidation: direct child self → element; label + mode filled; grandchild untouched; rqo not mutated', async () => {
		const rqo = {
			source: { tipo: SECTION },
			show: {
				ddo_map: [
					child(GRANTED),
					{ tipo: DENIED, parent: GRANTED, section_tipo: 'self', mode: 'edit', label: 'own' },
				],
			},
		};
		const snapshot = structuredClone(rqo);
		const map = (await build(rqo))?.[0]?.show.ddo_map ?? [];
		expect(map).toHaveLength(2);
		const [direct, grandchild] = map;
		expect(direct?.parent).toBe(SECTION);
		expect(direct?.section_tipo).toBe(SECTION);
		expect(typeof direct?.label).toBe('string');
		expect(direct?.mode).toBe('list');
		expect(grandchild?.parent).toBe(GRANTED);
		expect(grandchild?.section_tipo).toBe('self');
		expect(grandchild?.mode).toBe('edit');
		expect(grandchild?.label).toBe('own');
		expect(rqo).toEqual(snapshot);
	});

	test("a direct child naming ANOTHER section keeps parent 'self' (PHP: only a compatible section consolidates)", async () => {
		const map =
			(
				await build({
					source: { tipo: SECTION },
					show: { ddo_map: [child(GRANTED, { section_tipo: 'test38' })] },
				})
			)?.[0]?.show.ddo_map ?? [];
		expect(map[0]?.parent).toBe('self');
		expect(map[0]?.section_tipo).toBe('test38');
	});

	test("component element: 'self' resolves to its TARGET sections, never the component tipo", async () => {
		const map =
			(
				await build(
					{ source: { tipo: COMPONENT }, show: { ddo_map: [child(GRANTED)] } },
					componentElement(),
				)
			)?.[0]?.show.ddo_map ?? [];
		expect(map).toHaveLength(1);
		expect(map[0]?.parent).toBe(COMPONENT);
		expect(map[0]?.section_tipo).toEqual([SECTION]);
	});

	test("SECTION element: the four 'self' spellings of a direct child consolidate IDENTICALLY", async () => {
		for (const sectionTipo of SELF_SPELLINGS) {
			const map =
				(
					await build({
						source: { tipo: SECTION },
						show: { ddo_map: [child(GRANTED, { section_tipo: sectionTipo })] },
					})
				)?.[0]?.show.ddo_map ?? [];
			expect({ sectionTipo, parent: map[0]?.parent, section_tipo: map[0]?.section_tipo }).toEqual({
				sectionTipo,
				parent: SECTION,
				section_tipo: SECTION,
			});
		}
	});

	test("COMPONENT element: the four 'self' spellings of a direct child all mean its targets", async () => {
		for (const sectionTipo of SELF_SPELLINGS) {
			const map =
				(
					await build(
						{
							source: { tipo: COMPONENT },
							show: { ddo_map: [child(GRANTED, { section_tipo: sectionTipo })] },
						},
						componentElement(),
					)
				)?.[0]?.show.ddo_map ?? [];
			expect({ sectionTipo, parent: map[0]?.parent, section_tipo: map[0]?.section_tipo }).toEqual({
				sectionTipo,
				parent: COMPONENT,
				section_tipo: [SECTION],
			});
		}
	});

	test('invalid ddos are dropped, valid ones stand (shape, unresolvable model)', async () => {
		const map =
			(
				await build({
					source: { tipo: SECTION },
					show: { ddo_map: [{}, { tipo: '' }, child(UNRESOLVABLE), 'nope', child(GRANTED)] },
				})
			)?.[0]?.show.ddo_map ?? [];
		expect(map.map((ddo) => ddo.tipo)).toEqual([GRANTED]);
	});

	test('an EMAIL-shaped show is never a config: a string show → null; email-shaped tipos and ddo_map → dropped', async () => {
		// a non-object show is no show at all (only an object block builds the item)
		expect(await build({ source: { tipo: SECTION }, show: 'root@example.org' })).toBeNull();
		// a ddo_map that is a string builds the item with NO columns (never a column named by it)
		const stringMap = await build({
			source: { tipo: SECTION },
			show: { ddo_map: 'root@example.org' },
		});
		expect(stringMap?.[0]?.show).toEqual({ ddo_map: [] });
		// email-shaped TIPOS are dropped (no model resolves); the valid ddo stands
		const emailMap = {
			ddo_map: [
				child('root@example.org'),
				child('test1@example.org'),
				child(GRANTED, { section_tipo: 'admin@example.org' }),
				child(GRANTED),
			],
		};
		const internal =
			(await build({ source: { tipo: SECTION }, show: emailMap }))?.[0]?.show.ddo_map ?? [];
		expect(internal.map((ddo) => ddo.tipo)).toEqual([GRANTED, GRANTED]);
		// PHP validate_requested_ddo judges the tipo, not the section_tipo: an internal
		// resolution keeps the email-shaped section_tipo VERBATIM (it names no section,
		// so it resolves no row) …
		expect(internal[0]?.section_tipo).toBe('admin@example.org');
		// … and a real principal's stage 1 (ddoIsAuthorized, stricter than PHP) judges
		// EVERY declared section: the unreadable non-section is dropped with its ddo
		const restricted =
			(await build({ source: { tipo: SECTION }, show: emailMap }, sectionElement, nonAdmin))?.[0]
				?.show.ddo_map ?? [];
		expect(restricted.map((ddo) => ddo.tipo)).toEqual([GRANTED]);
		expect(JSON.stringify(restricted)).not.toContain('@');
	});

	test('a ddo whose model resolves but whose TLD is not installed is dropped (PHP check_active_tld)', async () => {
		const rqo = { source: { tipo: SECTION }, show: { ddo_map: [child(GRANTED)] } };
		// control: the real installed set keeps it
		expect(await isActiveTldTipo(GRANTED)).toBe(true);
		expect((await build(rqo))?.[0]?.show.ddo_map.map((ddo) => ddo.tipo)).toEqual([GRANTED]);
		const installed = await ddOntology.getActiveTlds();
		const narrowed = spyOn(ddOntology, 'getActiveTlds').mockResolvedValue(
			installed.filter((tld) => tld !== 'test'),
		);
		try {
			expect(await isActiveTldTipo(GRANTED)).toBe(false); // the seam took
			expect(await getModelByTipo(GRANTED)).not.toBeNull(); // the model still resolves
			expect((await build(rqo))?.[0]?.show.ddo_map).toEqual([]);
		} finally {
			narrowed.mockRestore();
		}
		expect(await isActiveTldTipo(GRANTED)).toBe(true);
	});

	test('dropped ddos are reported in ONE bounded, escaped log line per map', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const junk = Array.from({ length: 20 }, (_, index) => child(`test99999999${index}`));
			await build({
				source: { tipo: SECTION },
				show: { ddo_map: [...junk, child('test1\n[auth] login ok root'), child(GRANTED)] },
			});
			const lines = warn.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.startsWith('[request_config/from_rqo]'));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain('removed 21 client show ddo(s)');
			expect(lines[0]).toContain('(+16 more)');
			expect(lines[0]).not.toContain('\n');
		} finally {
			warn.mockRestore();
		}
	});

	test("consolidation: label/mode null are filled (PHP isset); model, permissions, limit are the server's", async () => {
		const map =
			(
				await build({
					source: { tipo: SECTION },
					show: {
						ddo_map: [
							child(GRANTED, {
								label: null,
								mode: null,
								model: 'component_password',
								permissions: 3,
								limit: 999_999_999,
							}),
							child(GRANTED, { limit: 0 }),
							child(GRANTED, { limit: 7 }),
						],
					},
				})
			)?.[0]?.show.ddo_map ?? [];
		expect(map).toHaveLength(3);
		const [first, allLimit, kept] = map;
		expect(typeof first?.label).toBe('string');
		expect(first?.mode).toBe('list');
		expect((first as Record<string, unknown>).model).toBe('component_publication');
		expect('permissions' in (first ?? {})).toBe(false);
		expect(first?.limit).toBe(CLIENT_MAX_LIMIT);
		expect(allLimit?.limit).toBe(CLIENT_MAX_LIMIT); // 0 = "all" never reaches a page raw
		expect(kept?.limit).toBe(7);
	});

	test('SECTION element: unauthorized ddos are dropped for a restricted principal (PHP STEP 11)', async () => {
		const rqo = {
			source: { tipo: SECTION },
			show: { ddo_map: [child(DENIED), child(GRANTED)] },
			search: { ddo_map: [child(DENIED)] },
		};
		const restricted = (await build(rqo, sectionElement, nonAdmin))?.[0];
		expect(restricted?.show.ddo_map.map((ddo) => ddo.tipo)).toEqual([GRANTED]);
		expect(restricted?.search?.ddo_map).toEqual([]);
		// control: an internal resolution (no principal) keeps both — the drop is the grant
		const internal = (await build(rqo))?.[0];
		expect(internal?.show.ddo_map.map((ddo) => ddo.tipo)).toEqual([DENIED, GRANTED]);
	});

	test('SECTION element: EVERY listed section is judged — a list is narrowed to the readable ones', async () => {
		// grandchildren (parent GRANTED): consolidation keeps their lists as declared
		const rqo = {
			source: { tipo: SECTION },
			show: {
				ddo_map: [
					child(GRANTED),
					{ tipo: GRANTED, parent: GRANTED, section_tipo: [OTHER_SECTION, SECTION] },
					{ tipo: GRANTED, parent: GRANTED, section_tipo: [OTHER_SECTION] },
				],
			},
		};
		const restricted = (await build(rqo, sectionElement, nonAdmin))?.[0]?.show.ddo_map ?? [];
		expect(restricted.map((ddo) => ddo.section_tipo)).toEqual([SECTION, [SECTION]]);
		// control: unfiltered, both lists stand as declared
		const internal = (await build(rqo))?.[0]?.show.ddo_map ?? [];
		expect(internal.map((ddo) => ddo.section_tipo)).toEqual([
			SECTION,
			[OTHER_SECTION, SECTION],
			[OTHER_SECTION],
		]);
	});

	test('SECTION element: a mixed self + source-array grandchild is judged on REAL sections — root loses nothing', async () => {
		// [{source:'self'}, {source:'section', value:[test38]}] resolves through the
		// one resolver to ['self', 'test38'] BEFORE the grant: the object entry was
		// judged as "no section" and silently dropped, even for root.
		const rqo = {
			source: { tipo: SECTION },
			show: {
				ddo_map: [
					child(GRANTED),
					{
						tipo: GRANTED,
						parent: 'test92x',
						section_tipo: [{ source: 'self' }, { source: 'section', value: [OTHER_SECTION] }],
					},
				],
			},
		};
		const internal = (await build(rqo))?.[0]?.show.ddo_map ?? [];
		expect(internal[1]?.section_tipo).toEqual(['self', OTHER_SECTION]);
		const asRoot = (await build(rqo, sectionElement, root))?.[0]?.show.ddo_map ?? [];
		expect(asRoot.map((ddo) => ddo.section_tipo)).toEqual(internal.map((ddo) => ddo.section_tipo));
		// the restricted actor keeps the 'self' (test3) part only — a real grant decision
		const restricted = (await build(rqo, sectionElement, nonAdmin))?.[0]?.show.ddo_map ?? [];
		expect(restricted[1]?.section_tipo).toEqual(['self']);
	});

	test('COMPONENT element: SERVER-derived children inherit the caller read (decision (d)), page 2 keeps them', async () => {
		// page 2 of a nested column (decision (a)): the restricted actor holds no
		// grant on (test3, test91), yet page 1 showed the column read-only (the
		// ontology path), so stage 1 must not empty page 2's columns.
		const element = componentElement([
			{ tipo: DENIED, parent: COMPONENT, section_tipo: [SECTION] },
			{ tipo: GRANTED, parent: COMPONENT, section_tipo: [SECTION] },
			// a server-derived grandchild at a section the actor cannot read
			{ tipo: GRANTED, parent: GRANTED, section_tipo: [OTHER_SECTION] },
		]);
		const map =
			(
				await build(
					{
						source: { tipo: COMPONENT },
						show: {
							ddo_map: [
								child(DENIED, { section_tipo: [SECTION] }),
								child(GRANTED),
								{ tipo: GRANTED, parent: GRANTED, section_tipo: OTHER_SECTION },
							],
						},
					},
					element,
					nonAdmin,
				)
			)?.[0]?.show.ddo_map ?? [];
		expect(map.map((ddo) => [ddo.tipo, ddo.section_tipo])).toEqual([
			[DENIED, [SECTION]],
			[GRANTED, [SECTION]],
			[GRANTED, OTHER_SECTION],
		]);
	});

	test('COMPONENT element: a client-INVENTED chain is judged, never raised to read (the dd200 → dd128 hole)', async () => {
		// Server config: only GRANTED at test3. The client adds what the ontology
		// never derives: DENIED as a direct child, and a grandchild under GRANTED
		// pointing at test38 (the shape of `dd200 created-by → a dd128 field`).
		const element = componentElement([
			{ tipo: GRANTED, parent: COMPONENT, section_tipo: [SECTION] },
		]);
		const rqo = {
			source: { tipo: COMPONENT },
			show: {
				ddo_map: [
					child(GRANTED),
					child(DENIED),
					{ tipo: GRANTED, parent: GRANTED, section_tipo: OTHER_SECTION },
					{ tipo: GRANTED, parent: GRANTED }, // undeclared: every locator of its parent
				],
			},
		};
		const restricted = (await build(rqo, element, nonAdmin))?.[0]?.show.ddo_map ?? [];
		expect(restricted.map((ddo) => [ddo.tipo, ddo.parent])).toEqual([[GRANTED, COMPONENT]]);
		// controls: the drop is the grant — root keeps every JUDGEABLE ddo; the
		// undeclared invented grandchild names no section to judge, so it fails
		// closed for any defined principal (ddoIsAuthorized's SEC-01 posture);
		// an internal resolution (no principal) filters nothing
		expect(
			(await build(rqo, element, root))?.[0]?.show.ddo_map.map((ddo) => ddo.section_tipo),
		).toEqual([[SECTION], [SECTION], OTHER_SECTION]);
		expect((await build(rqo, element))?.[0]?.show.ddo_map).toHaveLength(4);
	});

	test('COMPONENT element: a direct child is bound to the targets — mixed narrowed, foreign dropped', async () => {
		const cases: [unknown, unknown][] = [
			[[OTHER_SECTION, SECTION], [SECTION]],
			[[OTHER_SECTION], null],
			[OTHER_SECTION, null],
			[[{ source: 'section', value: [OTHER_SECTION] }], null],
			[[{ source: 'section', value: [OTHER_SECTION, SECTION] }], [SECTION]],
		];
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			for (const [declared, expected] of cases) {
				const map =
					(
						await build(
							{
								source: { tipo: COMPONENT },
								show: { ddo_map: [child(GRANTED, { section_tipo: declared })] },
							},
							componentElement(),
						)
					)?.[0]?.show.ddo_map ?? [];
				const outcome: unknown = map.length === 0 ? null : map[0]?.section_tipo;
				expect({ declared, outcome }).toEqual({ declared, outcome: expected as never });
				if (expected !== null) expect(map[0]?.parent).toBe(COMPONENT);
			}
			const reported = warn.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.includes('section_tipo outside the component targets'));
			expect(reported).toHaveLength(3);
		} finally {
			warn.mockRestore();
		}
	});

	test('clamped limits are folded into the ONE bounded line per map, never one line per ddo', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const map = Array.from({ length: 200 }, () => child(GRANTED, { limit: 1e9 }));
			const built = await build({ source: { tipo: SECTION }, show: { ddo_map: map } });
			expect(built?.[0]?.show.ddo_map.every((ddo) => ddo.limit === CLIENT_MAX_LIMIT)).toBe(true);
			const lines = warn.mock.calls.map((call) => String(call[0]));
			expect(lines.filter((line) => line.startsWith('[sqo] client limit'))).toEqual([]);
			const report = lines.filter((line) => line.startsWith('[request_config/from_rqo]'));
			expect(report).toHaveLength(1);
			expect(report[0]).toContain('clamped 200 client show ddo limit(s)');
			expect(report[0]).toContain('(+195 more)');
		} finally {
			warn.mockRestore();
		}
	});

	test('sqo: section_tipo validated + enriched; THE client gate scrubs it (sanitizeClientSqo)', async () => {
		const config = await build({
			source: { tipo: SECTION },
			show: { ddo_map: [child(GRANTED)] },
			sqo: {
				section_tipo: [SECTION, UNRESOLVABLE, 5],
				limit: 999_999_999,
				offset: -4,
				skip_projects_filter: true,
				TABLE: 'matrix_users',
				parsed: true,
				filter: {
					$and: [
						{ q: 'a', path: [{ section_tipo: SECTION, component_tipo: GRANTED }], column_sql: 'x' },
					],
				},
			},
		});
		const sqo = config?.[0]?.sqo;
		expect(sqo).toBeDefined();
		expect(sqo?.section_tipo.map((entry) => entry.tipo)).toEqual([SECTION]);
		expect(sqo?.section_tipo[0]?.typo).toBe('ddo');
		expect(sqo?.limit).toBe(CLIENT_MAX_LIMIT);
		expect(sqo?.offset).toBe(0);
		expect(sqo?.parsed).toBe(false);
		expect('skip_projects_filter' in (sqo ?? {})).toBe(false);
		expect('TABLE' in (sqo ?? {})).toBe(false);
		expect(JSON.stringify(sqo?.filter)).not.toContain('column_sql');
		expect(JSON.stringify(sqo?.filter)).toContain('"q":"a"');
	});

	test('sqo: a limit / offset the client did not send stays absent (PHP)', async () => {
		const sqo = (
			await build({
				source: { tipo: SECTION },
				show: { ddo_map: [child(GRANTED)] },
				sqo: { section_tipo: [SECTION] },
			})
		)?.[0]?.sqo;
		expect(sqo).toBeDefined();
		expect('limit' in (sqo ?? {})).toBe(false);
		expect('offset' in (sqo ?? {})).toBe(false);
	});

	test('no rqo sqo → no item sqo key (the element keeps its own sqo downstream)', async () => {
		const config = await build({ source: { tipo: SECTION }, show: { ddo_map: [child(GRANTED)] } });
		expect(config?.[0]).toBeDefined();
		expect('sqo' in (config?.[0] ?? {})).toBe(false);
	});

	test('COMPONENT element: a DATAFRAME direct child is bound to the OWNER section (scalar), never the targets', async () => {
		// owner test3, targets [test38]: page 2 resends page 1's processed show,
		// whose dataframe names the owner section — it must resolve as page 1 did
		const cases: [unknown, unknown][] = [
			[SECTION, SECTION], // the processed shape page 1 shipped
			...SELF_SPELLINGS.map((spelling): [unknown, unknown] => [spelling, SECTION]),
			[OTHER_SECTION, null], // a target holds none of the owner's frames
		];
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			for (const [declared, expected] of cases) {
				const map =
					(
						await build(
							{
								source: { tipo: COMPONENT },
								show: { ddo_map: [child(DATAFRAME, { section_tipo: declared })] },
							},
							foreignTargetElement,
							root,
						)
					)?.[0]?.show.ddo_map ?? [];
				const outcome: unknown = map.length === 0 ? null : map[0]?.section_tipo;
				expect({ declared, outcome }).toEqual({ declared, outcome: expected as never });
				if (expected !== null) expect(map[0]?.parent).toBe(COMPONENT);
			}
			const reported = warn.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.includes('dataframe section_tipo outside the owner section'));
			expect(reported).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
		// control: a NON-dataframe direct child's 'self' is still the targets
		const control = await build(
			{ source: { tipo: COMPONENT }, show: { ddo_map: [child(GRANTED)] } },
			foreignTargetElement,
			root,
		);
		expect(control?.[0]?.show.ddo_map[0]?.section_tipo).toEqual([OTHER_SECTION]);
	});

	test('a client source array outside the self/section grammar is refused before the resolver — one line per map', async () => {
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			// 300 distinct hierarchy_types values: none may reach the cross-request
			// typology cache; field_value / an unknown source / an oversize section
			// list are refused the same way
			const map = [
				...Array.from({ length: 300 }, (_, index) =>
					child(GRANTED, {
						section_tipo: [{ source: 'hierarchy_types', value: [10_000 + index] }],
					}),
				),
				child(GRANTED, { section_tipo: [{ source: 'field_value', value: ['test92'] }] }),
				child(GRANTED, { section_tipo: [{ source: 'evil\n[auth] fake', value: [SECTION] }] }),
				child(GRANTED, {
					section_tipo: [
						{
							source: 'section',
							value: Array.from({ length: CLIENT_SOURCE_ARRAY_MAX }, () => SECTION),
						},
					],
				}),
				// controls: the client grammar stands
				child(GRANTED, { section_tipo: [{ source: 'self' }] }),
				child(GRANTED, { section_tipo: [{ source: 'section', value: [SECTION] }] }),
			];
			const built = await build(
				{ source: { tipo: SECTION }, show: { ddo_map: map } },
				sectionElement,
				root,
			);
			expect(built?.[0]?.show.ddo_map).toHaveLength(2);
			const lines = warn.mock.calls.map((call) => String(call[0]));
			expect(lines.filter((line) => line.startsWith('[request_config/from_rqo]'))).toHaveLength(1);
			expect(lines.filter((line) => line.startsWith('[request_config/explicit]'))).toEqual([]);
			expect(lines.join('|')).toContain('removed 303 client show ddo(s)');
		} finally {
			warn.mockRestore();
		}
	});
});
