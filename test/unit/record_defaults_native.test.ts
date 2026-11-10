/**
 * RECORD BIRTH DEFAULTS — the create-door seeding contract (audit
 * 2026-08_oh1_beta B1 + §5.1).
 *
 * THE BUG THIS GATE EXISTS FOR: no TS door seeded the project locator
 * (component_filter) or the ontology-declared `properties.dato_default` on a
 * newly created record. A non-global-admin cataloguer's fresh record therefore
 * fell OUTSIDE the projects ACL — invisible in list/search, and every save on
 * it answered 403 "Record is out of the user scope". Every PHP-era record of
 * the audited section carried its project locator; the one TS-created record
 * did not.
 *
 * PHP behaviour being restored (live v7 mechanism):
 *  - component_filter::set_data_default + get_default_data_for_user
 *    (class.component_filter.php:174-470): a NON-admin gets the FIRST of their
 *    own dd170 projects; an admin (and a projects-less non-admin) gets
 *    DEDALO_DEFAULT_PROJECT / DEDALO_FILTER_SECTION_TIPO_DEFAULT.
 *  - component_common::set_data_default (class.component_common.php:753-869):
 *    the generic `properties.dato_default` seed, normalized through set_data
 *    (scalar → {id,lang,value}; locator → full relation locator with `type`,
 *    string section_id, from_component_tipo) with the item-id counter raised.
 *
 * DELIBERATE DIVERGENCE (WC-2026-08-09-record-birth-defaults): PHP seeds on the first EDIT-FORM BUILD; TS
 * seeds at the CREATE DOOR. Same end state for a new record, one chokepoint
 * for create/import/ts_api/portal-"+" instead of a render side-effect.
 *
 * Scratch hygiene: one scratch dd128 user (id band 9999987x) carrying a dd170
 * project locator, plus counter-minted twins of the audited section. Rows +
 * their TM/activity rows are swept in afterAll. Suite DB only.
 */
// Migrated to the generic `test` TLD 2026-08-20 (AGENTS.md hard rules): every
// install section and component was rewritten through
// src/core/test_data/test_tld_tipo_map.json (oh1→test6813, oh22→test6834,
// oh21→test6833, oh93→test6889, oh32→test6844, oh29→test6841,
// numisdata3→test6099, numisdata77→test6157, numisdata4→test6100,
// dmm263→test1226, and the virtual pair rsc170→rsc2 replaced by the `test`
// virtual pair test7007→testheritagecatalog1). The carrier TABLE is no longer
// the hard-coded `matrix`: a cloned `test` section carries the test24
// matrix_table node, so the table is RESOLVED from the ontology in beforeAll
// and pinned to `matrix_test` — writing to `matrix` here would have been a
// silent wrong-table write.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../src/config/config.ts';
import { allComponentModels } from '../../src/core/components/registry.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { DedaloError } from '../../src/core/errors/index.ts';
import {
	getComponentFilterTipo,
	getMatrixTableFromTipo,
} from '../../src/core/ontology/resolver.ts';
import { applyAddNewElement, deletePortalLocator } from '../../src/core/relations/save.ts';
import { createSectionRecord } from '../../src/core/section/record/create_record.ts';
import {
	buildRecordDefaultColumns,
	clearRecordDefaultsCache,
	getSectionDefaultsSpec,
	normalizeDatoDefault,
	normalizeDefaultItems,
	resolveDefaultFilterData,
} from '../../src/core/section/record/record_defaults.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	getSectionPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { isRecordInScope } from '../../src/core/security/record_scope.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';

const REPO_ROOT = dirname(dirname(import.meta.dir));

const SECTION = 'test6813';
const FILTER_TIPO = 'test6834';
/** The portal "+" fixture triple (same as portal_edit_writes_native). */
const HOST_SECTION = 'test6099';
const PORTAL = 'test6157';
const TARGET_SECTION = 'test6100';
/** TARGET_SECTION's button_new (the create grant the portal "+" needs). */
const TARGET_BUTTON_NEW = 'test6274';
/**
 * WHERE these sections store. Resolved from the ontology in beforeAll (a `test`
 * clone carries the test24 matrix_table node → `matrix_test`) and asserted
 * there, never assumed: every raw SQL string below interpolates it.
 */
let TABLE = '';
/** A scratch dd128 user: no dd244 flag ⇒ NOT a global admin. */
const SCRATCH_USER = 99999871;
/** A scratch dd128 user with NO dd170 projects and NO profile ⇒ level 0. */
const SCRATCH_USER_NO_PROJECTS = 99999872;
/** Deliberately NOT DEDALO_DEFAULT_PROJECT, so "their own project" is provable. */
const SCRATCH_PROJECT = 99871;
/** A scratch dd234 profile granting SCRATCH_USER level 2 on the host section and its portal, and the create grant (section + button_new) on the portal target. */
const SCRATCH_PROFILE = 99999871;

const created: { sectionTipo: string; sectionId: number }[] = [];
function track(sectionTipo: string, sectionId: number): number {
	created.push({ sectionTipo, sectionId });
	return sectionId;
}

let nonAdmin: Principal;
let projectlessNonAdmin: Principal;

async function relationOf(sectionId: number, tipo: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT relation->$3 AS items FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, tipo],
	)) as { items: unknown }[];
	return rows[0]?.items ?? null;
}

async function metaOf(sectionId: number, tipo: string): Promise<unknown> {
	const rows = (await sql.unsafe(
		`SELECT meta->$3 AS counter FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
		[SECTION, sectionId, tipo],
	)) as { counter: unknown }[];
	return rows[0]?.counter ?? null;
}

/** Activity rows this actor left for a section (the 'NEW' audit assertion). */
async function activityCountFor(userId: number, sectionTipo: string): Promise<number> {
	const rows = (await sql.unsafe(
		`SELECT count(*)::int AS n FROM matrix_activity
		 WHERE section_tipo = 'dd542'
		   AND relation @> $1::text::jsonb
		   AND string @> $2::text::jsonb`,
		[
			// The actor address is minted INT (WC-2026-08-10-section-id-int-canonical,
			// activity_log.ts) and jsonb `@>` is type-strict — probing the string
			// form matched nothing and silently counted 0.
			JSON.stringify({ dd543: [{ section_id: userId }] }),
			JSON.stringify({ dd546: [{ value: sectionTipo }] }),
		],
	)) as { n: number }[];
	return rows[0]?.n ?? 0;
}

async function sweepScratchFixtures(): Promise<void> {
	for (const id of [SCRATCH_USER, SCRATCH_USER_NO_PROJECTS]) {
		await sql.unsafe('DELETE FROM matrix_users WHERE section_tipo = $1 AND section_id = $2', [
			'dd128',
			id,
		]);
	}
	await sql.unsafe('DELETE FROM matrix_profiles WHERE section_tipo = $1 AND section_id = $2', [
		'dd234',
		SCRATCH_PROFILE,
	]);
	await sql.unsafe(
		`DELETE FROM matrix_activity
		 WHERE section_tipo = 'dd542' AND relation @> $1::text::jsonb`,
		[JSON.stringify({ dd543: [{ section_id: String(SCRATCH_USER) }] })],
	);
}

beforeAll(async () => {
	// The table the ONTOLOGY resolves for each section under test — proven, not
	// hard-coded. All three are phase-2 clones, so all three land in matrix_test.
	for (const tipo of [SECTION, HOST_SECTION, TARGET_SECTION]) {
		expect(await getMatrixTableFromTipo(tipo)).toBe('matrix_test');
	}
	TABLE = 'matrix_test';
	await sweepScratchFixtures();
	// A profile granting level 2 on the portal host section (PHP dd774 matrix).
	await sql.unsafe(
		`INSERT INTO matrix_profiles (section_tipo, section_id, misc)
		 VALUES ($1, $2, $3::text::jsonb)`,
		[
			'dd234',
			SCRATCH_PROFILE,
			JSON.stringify({
				// The section AND the portal at 2: deletePortalLocator goes through
				// the write door (section floor 2 + the pair at 2 + the scope).
				dd774: [
					{ tipo: HOST_SECTION, section_tipo: HOST_SECTION, value: 2 },
					{ tipo: PORTAL, section_tipo: HOST_SECTION, value: 2 },
					// The portal "+" CREATES in TARGET_SECTION as this user: the T0-2
					// New-button predicate (write_door.ts authorizeRecordCreate) asks the
					// target section ≥ 2 AND its button_new (test6274) ≥ 2.
					{ tipo: TARGET_SECTION, section_tipo: TARGET_SECTION, value: 2 },
					{ tipo: TARGET_BUTTON_NEW, section_tipo: TARGET_SECTION, value: 2 },
				],
			}),
		],
	);
	await sql.unsafe(
		`INSERT INTO matrix_users (section_tipo, section_id, relation)
		 VALUES ($1, $2, $3::text::jsonb)`,
		[
			'dd128',
			SCRATCH_USER,
			JSON.stringify({
				dd170: [
					{
						id: 1,
						type: 'dd675',
						// int-canonical stored address (WC-2026-08-10-section-id-int-canonical)
						section_id: SCRATCH_PROJECT,
						section_tipo: config.features.filterSectionTipo,
						from_component_tipo: 'dd170',
					},
				],
				dd1725: [
					{
						id: 1,
						type: 'dd151',
						section_id: String(SCRATCH_PROFILE),
						section_tipo: 'dd234',
						from_component_tipo: 'dd1725',
					},
				],
			}),
		],
	);
	await sql.unsafe(
		`INSERT INTO matrix_users (section_tipo, section_id, relation)
		 VALUES ($1, $2, $3::text::jsonb)`,
		['dd128', SCRATCH_USER_NO_PROJECTS, JSON.stringify({})],
	);
	clearUserProjectsCache();
	clearPrincipalCache();
	clearPermissionsCache();
	nonAdmin = await resolvePrincipal(SCRATCH_USER);
	projectlessNonAdmin = await resolvePrincipal(SCRATCH_USER_NO_PROJECTS);
}, 60000);

afterAll(async () => {
	for (const { sectionTipo, sectionId } of created) {
		await sql.unsafe(`DELETE FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`, [
			sectionTipo,
			sectionId,
		]);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[sectionTipo, sectionId],
		);
	}
	await sweepScratchFixtures();
	clearUserProjectsCache();
	clearPrincipalCache();
	clearPermissionsCache();
});

// ---------------------------------------------------------------------------
// 1. THE HEADLINE (B1): a non-admin's new record is inside their own scope.
// ---------------------------------------------------------------------------

describe('B1: a record created by a NON-global-admin is born inside their project scope', () => {
	test('fixture assumptions hold (drift must redden, not vacuously pass)', () => {
		expect(nonAdmin.isGlobalAdmin).toBe(false);
		expect(projectlessNonAdmin.isGlobalAdmin).toBe(false);
		expect(SCRATCH_PROJECT).not.toBe(config.features.defaultProject);
	});

	test('the created record carries the caller OWN project locator, and is in their read scope', async () => {
		const twin = track(SECTION, await createSectionRecord(SECTION, SCRATCH_USER));

		expect(await relationOf(twin, FILTER_TIPO)).toEqual([
			{
				id: 1,
				type: 'dd675', // DEDALO_RELATION_TYPE_FILTER
				// int-canonical stored address (WC-2026-08-10-section-id-int-canonical)
				section_id: SCRATCH_PROJECT,
				section_tipo: config.features.filterSectionTipo,
				from_component_tipo: FILTER_TIPO,
			},
		]);

		// …and the projects ACL — the gate that answered 403 — now sees it.
		expect(await isRecordInScope(SECTION, twin, nonAdmin)).toBe(true);
	}, 60000);

	test('the item-id counter absorbs the seeded id (a later allocation cannot reuse it)', async () => {
		const twin = track(SECTION, await createSectionRecord(SECTION, SCRATCH_USER));
		expect(await metaOf(twin, FILTER_TIPO)).toEqual([{ count: 1 }]);
	}, 60000);

	test('a projects-less non-admin falls back to DEDALO_DEFAULT_PROJECT (PHP config fallback)', async () => {
		const twin = track(SECTION, await createSectionRecord(SECTION, SCRATCH_USER_NO_PROJECTS));
		expect(await relationOf(twin, FILTER_TIPO)).toEqual([
			{
				id: 1,
				type: 'dd675',
				section_id: config.features.defaultProject,
				section_tipo: config.features.filterSectionTipo,
				from_component_tipo: FILTER_TIPO,
			},
		]);
	}, 60000);

	test('a global admin gets DEDALO_DEFAULT_PROJECT (PHP is_global_admin branch)', async () => {
		const twin = track(SECTION, await createSectionRecord(SECTION, -1));
		expect(await relationOf(twin, FILTER_TIPO)).toEqual([
			{
				id: 1,
				type: 'dd675',
				section_id: config.features.defaultProject,
				section_tipo: config.features.filterSectionTipo,
				from_component_tipo: FILTER_TIPO,
			},
		]);
	}, 60000);
});

// ---------------------------------------------------------------------------
// 2. Generic properties.dato_default (PHP component_common::set_data_default).
// ---------------------------------------------------------------------------

describe('generic properties.dato_default seeding', () => {
	test('the section receives its ontology-declared test6833 / test6889 / test6844 defaults, normalized', async () => {
		const twin = track(SECTION, await createSectionRecord(SECTION, -1));
		// test6833 Quality → dd889/5 ; test6889 Review status → dd501/1 ;
		// test6844 publication → dd64/2 (the clone keeps the declared dato_default).
		expect(await relationOf(twin, 'test6833')).toEqual([
			{
				id: 1,
				type: 'dd151',
				section_id: 5,
				section_tipo: 'dd889',
				from_component_tipo: 'test6833',
			},
		]);
		expect(await relationOf(twin, 'test6889')).toEqual([
			{
				id: 1,
				type: 'dd151',
				section_id: 1,
				section_tipo: 'dd501',
				from_component_tipo: 'test6889',
			},
		]);
		expect(await relationOf(twin, 'test6844')).toEqual([
			{
				id: 1,
				type: 'dd151',
				section_id: 2,
				section_tipo: 'dd64',
				from_component_tipo: 'test6844',
			},
		]);
	}, 60000);

	test('a LITERAL dato_default normalizes to the {id,lang,value} item shape', async () => {
		// hierarchy109 (component_input_text) declares ["hierarchy20"]; the stored
		// twin shape is [{id:1, lang:'lg-nolan', value:'hierarchy20'}] (verified
		// against the sibling hierarchy101 colour default on real records).
		const columns = await buildRecordDefaultColumns('hierarchy1', -1);
		expect(columns.string?.hierarchy109).toEqual([
			{ id: 1, lang: 'lg-nolan', value: 'hierarchy20' },
		]);
	}, 60000);

	test('a section with neither a component_filter nor a dato_default seeds NOTHING', async () => {
		// dd128 (Users) is project-less and declares no dato_default — its birth
		// row must stay exactly {data, relation:{dd200}, date:{dd199}}.
		expect(await buildRecordDefaultColumns('dd128', -1)).toEqual({});
	}, 60000);

	test("the PHP unit-test sentinel section 'test3' is excluded from the filter seed", async () => {
		// PHP component_filter::set_data_default:230 — never pollute the test
		// playground with a real project assignment.
		expect(await buildRecordDefaultColumns('test3', -1)).toEqual({});
	}, 60000);

	test('an unsupported dato_default shape THROWS instead of narrowing silently', () => {
		// PHP resolves {"method": …} through component_common::get_method; no
		// ontology row uses it today, so the path is UNPORTED and must be loud.
		expect(() => normalizeDatoDefault({ method: 'get_today_date' }, 'test6841')).toThrow(
			/dato_default.*method/i,
		);
	});

	test('an empty dato_default is a no-op (PHP !empty gate)', () => {
		expect(normalizeDatoDefault([], 'test6833')).toEqual([]);
		expect(normalizeDatoDefault('', 'test6833')).toEqual([]);
		expect(normalizeDatoDefault(null, 'test6833')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2b. NO MODEL WHITELIST. PHP component_common::set_data (:918-1010) is GENERIC:
//     every model that is not the relation family runs the same three steps
//     (non-object → {value}; lang ONLY when supports_translation; id from the
//     counter) and the base validate_data_element (:901) returns the element
//     unchanged. A TS whitelist of "relation or translatable literal" makes
//     every OTHER model's declared default a hard create failure — dmm1
//     (component_date defaults dmm263/4/5) and nexus40 (component_json
//     nexus52) are uncreatable on the two production installs.
// ---------------------------------------------------------------------------

describe('generic set_data normalization — every model, no whitelist', () => {
	test('component_date: the declared object is kept VERBATIM, id added, NO lang', async () => {
		// the component_date default cloned from dedalo7_mdcat dmm263. PHP: not a relation,
		// supports_translation=false ⇒ base validate_data_element returns it as-is
		// with only the counter id. Stored twin verified against real
		// component_date rows: {id, start:{…}} — an id plus the model's own keys.
		const { items, counter } = await normalizeDefaultItems('test1226', 'component_date', [
			{ period: { time: 0, month: 1 } },
		]);
		expect(items).toEqual([{ period: { time: 0, month: 1 }, id: 1 }]);
		expect(counter).toBe(1);
	});

	test('component_json: an OBJECT dato_default survives whole', async () => {
		// The shape comes from a shipped component_json that declares a
		// request_config source OBJECT. PHP wraps the non-array into [obj]
		// (set_data_default :828-833) and stores it with an id. Nothing about it is
		// a locator and nothing is lang-tagged. The tipo is OPAQUE here — the model
		// is passed in — so a generic one carries the same meaning.
		const declared = normalizeDatoDefault(
			{ source: { request_config: [{ sqo: { section_tipo: [] } }] } },
			'test9052',
		);
		const { items } = await normalizeDefaultItems('test9052', 'component_json', declared);
		expect(items).toEqual([
			{ source: { request_config: [{ sqo: { section_tipo: [] } }] } as unknown, id: 1 },
		]);
	});

	test('a NON-translatable literal model wraps a scalar into {value} with NO lang', async () => {
		// component_number: value-bearing, supports_translation=false. PHP wraps
		// the scalar (set_data :959-968) but the lang guard (:978) never fires.
		const { items } = await normalizeDefaultItems('dd0', 'component_number', [7]);
		expect(items).toEqual([{ value: 7, id: 1 }]);
	});

	test('a translatable literal still gets its lang (component_input_text)', async () => {
		const { items } = await normalizeDefaultItems('hierarchy101', 'component_input_text', [
			'#f78a1c',
		]);
		expect(items).toEqual([{ value: '#f78a1c', lang: 'lg-nolan', id: 1 }]);
	});

	test('an explicit id in the declaration is honoured and raises the counter (PHP has_id)', async () => {
		const { items, counter } = await normalizeDefaultItems('test9052', 'component_json', [
			{ k: 'a', id: 7 },
			{ k: 'b' },
		]);
		expect(items).toEqual([
			{ k: 'a', id: 7 },
			{ k: 'b', id: 1 },
		]);
		// PHP: one allocation (the id-less element) then raise_component_counter(7).
		expect(counter).toBe(7);
	});

	test('a relation default that is NOT a locator is REJECTED and logged, never fatal', async () => {
		// PHP component_relation_common::validate_data_element :1068-1077 returns
		// FALSE for a locator without section_id/section_tipo — the element is
		// dropped with an ERROR log and the record is still created. Throwing here
		// would make the whole section uncreatable through every door.
		const { items } = await normalizeDefaultItems('test6889', 'component_radio_button', [
			{ nonsense: true },
		]);
		expect(items).toEqual([]);
	});

	test('a relation default declared twice is deduped (PHP locator_lookup_map)', async () => {
		const { items } = await normalizeDefaultItems('test6889', 'component_radio_button', [
			{ section_id: '1', section_tipo: 'dd501' },
			{ section_id: 1, section_tipo: 'dd501' },
		]);
		expect(items.length).toBe(1);
	});

	test('THE ANTI-WHITELIST TRIPWIRE: every registered component model normalizes', async () => {
		// PHP set_data is generic, so a dato_default is normalizable on EVERY
		// model — there is no such thing as "a model whose default we refuse".
		// This gate is deliberately install-INDEPENDENT: the dev ontology happens
		// to declare defaults on 5 models, production installs on 7, and a
		// whitelist keyed to whichever models the local DB uses is not a gate.
		// A locator-shaped probe doubles as a plain object for the generic branch.
		const probe = { section_id: '1', section_tipo: 'dd64' };
		const failures: string[] = [];
		for (const descriptor of allComponentModels()) {
			// Alias-only stubs store nothing under their own name (no column).
			if (descriptor.column === undefined) continue;
			try {
				const { items } = await normalizeDefaultItems('test6889', descriptor.model, [probe]);
				if (items.length !== 1) failures.push(`${descriptor.model}: dropped the default`);
			} catch (error) {
				failures.push(`${descriptor.model}: ${(error as Error).message}`);
			}
		}
		expect(allComponentModels().length).toBeGreaterThan(20); // never vacuous
		expect(failures).toEqual([]);
	}, 60000);

	test('EVERY section in the ontology builds its birth defaults without throwing', async () => {
		// The census half: whatever THIS install declares, every door must be able
		// to create every section. (dedalo7_mht nexus40 and dedalo7_mdcat dmm1
		// were the two real casualties of the whitelist.)
		const sections = (await sql`
			SELECT tipo FROM dd_ontology WHERE model = 'section' ORDER BY tipo
		`) as { tipo: string }[];
		expect(sections.length).toBeGreaterThan(50); // drift must redden, not vacuously pass
		const failures: string[] = [];
		for (const { tipo } of sections) {
			try {
				await buildRecordDefaultColumns(tipo, -1);
			} catch (error) {
				failures.push(`${tipo}: ${(error as Error).message}`);
			}
		}
		expect(failures).toEqual([]);
	}, 180000);
});

// ---------------------------------------------------------------------------
// 2c. VIRTUAL SECTIONS borrow the REAL section's components (the
//     getSectionRealTipo law) — so they borrow its dato_defaults too.
// ---------------------------------------------------------------------------

describe('virtual sections inherit the REAL section defaults', () => {
	test('test7007 (virtual → testheritagecatalog1) seeds the same components the real section does', async () => {
		const virtualSpec = await getSectionDefaultsSpec('test7007');
		const realSpec = await getSectionDefaultsSpec('testheritagecatalog1');
		expect(realSpec.items.length).toBeGreaterThan(0); // the pin is not vacuous
		// The virtual section's own children are exclude_elements/section_list/
		// buttons — never components — so the borrowed set is the real one MINUS
		// whatever its FIRST exclude_elements child names (resolveVirtualEditScope).
		const virtualTipos = virtualSpec.items.map((item) => item.tipo);
		const realTipos = realSpec.items.map((item) => item.tipo);
		expect(realTipos).toEqual(expect.arrayContaining(virtualTipos));
		expect(virtualTipos.length).toBeGreaterThan(0);
	}, 60000);

	test('the walk is the virtual EDIT scope, never a plain WHERE parent = sectionTipo', () => {
		// The law from CLAUDE.md: a `parent = <virtual tipo>` walk returns only
		// exclude_elements/section_list/buttons. The previous shape here was
		// `if (own.length > 0) return own` — a virtual section owning ANY
		// component silently dropped the real section's whole default set.
		const source = readFileSync(
			join(REPO_ROOT, 'src/core/section/record/record_defaults.ts'),
			'utf-8',
		);
		expect(source).toContain('resolveVirtualEditScope');
		expect(source).not.toContain('if (own.length > 0) return own');
	});
});

// ---------------------------------------------------------------------------
// 2d. The per-section spec is CACHED (an uncached recursive CTE + a model
//     lookup per component on EVERY create is paid by CSV import, ontology and
//     hierarchy provisioning too).
// ---------------------------------------------------------------------------

describe('the derived per-section spec is ontology-cached', () => {
	test('same reference on a hit; a new one after the named clearer fires', async () => {
		const first = await getSectionDefaultsSpec(SECTION);
		const second = await getSectionDefaultsSpec(SECTION);
		expect(second).toBe(first); // cache hit — no second CTE
		clearRecordDefaultsCache();
		expect(await getSectionDefaultsSpec(SECTION)).not.toBe(first);
	}, 60000);
});

// ---------------------------------------------------------------------------
// 3. The filter cascade, unit-level (no hardcoded locator anywhere).
// ---------------------------------------------------------------------------

describe('resolveDefaultFilterData cascade', () => {
	test('never emits a hardcoded project: the config default is the only fallback', async () => {
		const admin = await resolveDefaultFilterData(-1, FILTER_TIPO);
		expect(admin).toEqual([
			{
				id: 1,
				type: 'dd675',
				section_id: config.features.defaultProject,
				section_tipo: config.features.filterSectionTipo,
				from_component_tipo: FILTER_TIPO,
			},
		]);
		const own = await resolveDefaultFilterData(SCRATCH_USER, FILTER_TIPO);
		expect((own[0] as { section_id: number }).section_id).toBe(SCRATCH_PROJECT);
	}, 60000);

	test('the engine holds no hardcoded project locator any more', () => {
		// The portal "+" used to mint `{section_tipo:'dd153', section_id:'1'}`
		// regardless of DEDALO_DEFAULT_PROJECT (audit §5.1). A static pin: the
		// only place a project locator may be built is the typed config.
		const source = readFileSync(join(REPO_ROOT, 'src/core/relations/save.ts'), 'utf-8');
		expect(source).not.toContain("section_tipo: 'dd153'");
		expect(source).toContain('config.features.filterSectionTipo');
	});
});

// ---------------------------------------------------------------------------
// 4. The portal "+" door (applyAddNewElement): real actor, real project.
// ---------------------------------------------------------------------------

describe('portal "+" creates as the REAL caller, in a project they can see', () => {
	test('attribution, inherited project and the NEW activity row', async () => {
		const host = track(HOST_SECTION, await createSectionRecord(HOST_SECTION, SCRATCH_USER));
		const before = await activityCountFor(SCRATCH_USER, TARGET_SECTION);

		const outcome = await runWithRequestContext(
			{ principal: nonAdmin, session: null, requestId: 'record-defaults-test', clientIp: '::1' },
			() => applyAddNewElement([], TARGET_SECTION, PORTAL, HOST_SECTION, host),
		);
		expect(outcome).not.toBeNull();
		const newId = track(TARGET_SECTION, (outcome as { sectionId: number }).sectionId);

		// (a) attributed to the caller, NOT the superuser (-1).
		const rows = (await sql.unsafe(
			`SELECT data, relation FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[TARGET_SECTION, newId],
		)) as { data: Record<string, unknown>; relation: Record<string, unknown[]> }[];
		expect(rows[0]?.data.created_by_user_id).toBe(SCRATCH_USER);
		expect(rows[0]?.relation.dd200).toEqual([
			{
				id: 1,
				type: 'dd151',
				section_id: SCRATCH_USER,
				section_tipo: 'dd128',
				from_component_tipo: 'dd200',
			},
		]);

		// (b) the HOST's project (which is the caller's own) is inherited and
		//     re-stamped onto the TARGET's own component_filter tipo.
		const targetFilterTipo = await getComponentFilterTipo(TARGET_SECTION);
		expect(targetFilterTipo).not.toBeNull();
		expect(rows[0]?.relation[targetFilterTipo as string]).toEqual([
			{
				id: 1,
				type: 'dd675',
				// int-canonical stored address (WC-2026-08-10-section-id-int-canonical)
				section_id: SCRATCH_PROJECT,
				section_tipo: config.features.filterSectionTipo,
				from_component_tipo: targetFilterTipo,
			},
		]);

		// (c) the NEW activity row PHP's create_record emits (step 7).
		expect(await activityCountFor(SCRATCH_USER, TARGET_SECTION)).toBe(before + 1);
	}, 60000);

	test('an EMPTY intersection falls back to DEDALO_DEFAULT_PROJECT, not to the caller', async () => {
		// TWO PHP rules, and they are NOT the same rule:
		//  - get_current_section_filter_data (:5199) intersects the host's projects
		//    with the caller's — "only intersections are accepted";
		//  - add_new_element (component_relation_common.php:3798-3813) then handles
		//    the EMPTY result itself, with DEDALO_SECTION_PROJECTS_TIPO /
		//    DEDALO_DEFAULT_PROJECT / DEDALO_RELATION_TYPE_FILTER — it never calls
		//    get_default_data_for_user, so the caller's own first project is NOT
		//    the fallback here (it IS at the plain create door — the asymmetry is
		//    PHP's and is documented in WC-2026-08-09-record-birth-defaults).
		// A host in project X, a caller authorized only for SCRATCH_PROJECT.
		const host = track(HOST_SECTION, await createSectionRecord(HOST_SECTION, -1));
		const hostFilterTipo = (await getComponentFilterTipo(HOST_SECTION)) as string;
		await sql.unsafe(
			`UPDATE ${TABLE} SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($1::text, $2::text::jsonb)
			 WHERE section_tipo = $3 AND section_id = $4`,
			[
				hostFilterTipo,
				JSON.stringify([
					{
						id: 1,
						type: 'dd675',
						section_id: '424242',
						section_tipo: config.features.filterSectionTipo,
						from_component_tipo: hostFilterTipo,
					},
				]),
				HOST_SECTION,
				host,
			],
		);

		const outcome = await runWithRequestContext(
			{ principal: nonAdmin, session: null, requestId: 'record-defaults-test', clientIp: '::1' },
			() => applyAddNewElement([], TARGET_SECTION, PORTAL, HOST_SECTION, host),
		);
		const newId = track(TARGET_SECTION, (outcome as { sectionId: number }).sectionId);
		const targetFilterTipo = (await getComponentFilterTipo(TARGET_SECTION)) as string;
		const rows = (await sql.unsafe(
			`SELECT relation->$3 AS items FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[TARGET_SECTION, newId, targetFilterTipo],
		)) as { items: Record<string, unknown>[] }[];
		expect(rows[0]?.items).toEqual([
			{
				id: 1,
				type: 'dd675',
				section_id: config.features.defaultProject,
				section_tipo: config.features.filterSectionTipo,
				from_component_tipo: targetFilterTipo,
			},
		]);
		// …and it is emphatically NOT the caller's own project (the divergence
		// this test used to pin).
		expect(rows[0]?.items?.[0]?.section_id).not.toBe(String(SCRATCH_PROJECT));
	}, 60000);

	test('the TEMPORAL door (no host to inherit from) takes the same default-project branch', async () => {
		// PHP add_new_element :3796 — `$this->is_temporal===true` short-circuits
		// get_current_section_filter_data to null, which is the very same empty
		// case as above. skipHostFilterRead is the TS twin.
		const outcome = await runWithRequestContext(
			{ principal: nonAdmin, session: null, requestId: 'record-defaults-test', clientIp: '::1' },
			() =>
				applyAddNewElement([], TARGET_SECTION, PORTAL, HOST_SECTION, -1, {
					skipHostFilterRead: true,
				}),
		);
		const newId = track(TARGET_SECTION, (outcome as { sectionId: number }).sectionId);
		const targetFilterTipo = (await getComponentFilterTipo(TARGET_SECTION)) as string;
		const rows = (await sql.unsafe(
			`SELECT relation->$3 AS items FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[TARGET_SECTION, newId, targetFilterTipo],
		)) as { items: Record<string, unknown>[] }[];
		expect(rows[0]?.items?.[0]?.section_id).toBe(config.features.defaultProject);
	}, 60000);
});

// ---------------------------------------------------------------------------
// 5. deletePortalLocator gates on the LEVEL-2 write grant, not isGlobalAdmin
//    (the full door — pair, scope, dd128, order — is portal_locator_door_native).
// ---------------------------------------------------------------------------

describe('deletePortalLocator goes through the write door (section 2 + pair 2 + scope)', () => {
	async function seedPortal(host: number, items: unknown[]): Promise<void> {
		await sql.unsafe(
			`UPDATE ${TABLE} SET relation = COALESCE(relation, '{}'::jsonb) || jsonb_build_object($1::text, $2::text::jsonb)
			 WHERE section_tipo = $3 AND section_id = $4`,
			[PORTAL, JSON.stringify(items), HOST_SECTION, host],
		);
	}
	const link = (id: number, targetId: number) => ({
		id,
		type: 'dd151',
		section_id: String(targetId),
		section_tipo: TARGET_SECTION,
		from_component_tipo: PORTAL,
	});

	test('a level-0 non-admin is refused and nothing is removed', async () => {
		const host = track(HOST_SECTION, await createSectionRecord(HOST_SECTION, SCRATCH_USER));
		await seedPortal(host, [link(1, 101), link(2, 102)]);
		// The refusal is a THROW now (ERRORS_SPEC §4) — asserted by code, and the
		// refused section rides as a LOG-ONLY coordinate.
		let refusal: DedaloError | null = null;
		try {
			await deletePortalLocator(
				projectlessNonAdmin, // no profile ⇒ level 0 on the host section
				{ tipo: PORTAL, section_tipo: HOST_SECTION, section_id: host },
				{ locator: link(1, 101), ar_properties: ['section_tipo', 'section_id'] },
			);
		} catch (error) {
			refusal = error as DedaloError;
		}
		expect(refusal).toBeInstanceOf(DedaloError);
		expect(refusal?.code).toBe('perm.denied');
		expect(refusal?.spec.status).toBe(403);
		const rows = (await sql.unsafe(
			`SELECT relation->$3 AS items FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[HOST_SECTION, host, PORTAL],
		)) as { items: unknown[] }[];
		expect(rows[0]?.items?.length).toBe(2);
	}, 60000);

	test('a NON-admin holding level 2 removes the locator (the half-completed "delete index")', async () => {
		const host = track(HOST_SECTION, await createSectionRecord(HOST_SECTION, SCRATCH_USER));
		await seedPortal(host, [link(1, 101), link(2, 102)]);
		expect(await getSectionPermissions(nonAdmin, HOST_SECTION)).toBe(2);
		// In scope through the filter birth default (the creator's own project).
		expect(await isRecordInScope(HOST_SECTION, host, nonAdmin)).toBe(true);

		const response = await deletePortalLocator(
			nonAdmin,
			{ tipo: PORTAL, section_tipo: HOST_SECTION, section_id: host },
			{ locator: link(1, 101), ar_properties: ['section_tipo', 'section_id'] },
		);
		expect(response.removed).toBe(1);
		const rows = (await sql.unsafe(
			`SELECT relation->$3 AS items FROM ${TABLE} WHERE section_tipo = $1 AND section_id = $2`,
			[HOST_SECTION, host, PORTAL],
		)) as { items: Record<string, unknown>[] }[];
		expect(rows[0]?.items?.map((locator) => locator.section_id)).toEqual(['102']);
	}, 60000);
});
