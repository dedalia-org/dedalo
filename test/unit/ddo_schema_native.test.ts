/**
 * DDO WIRE SCHEMA vs the REAL ontology (audit 2026-08 §7, finding X1).
 *
 * `ddoSchema` (src/core/concepts/ddo.ts) is BOTH the client-echo sanitization
 * gate AND a hard parse gate: `rqoSchema` embeds it, and server.ts 400s the
 * WHOLE request when the parse fails ("Invalid RQO"). So a single value-TYPE
 * mismatch between the schema and an ontology-authored ddo does not degrade a
 * field — it kills every request that carries that ddo_map.
 *
 * The PHP oracle (request_config_object::sanitize_client_ddo_map,
 * core/common/class.request_config_object.php:673) whitelists KEYS and never
 * types their values (only limit/offset are shape-checked). TS types them, so
 * the schema is only correct if every type it declares is the type the
 * ontology actually stores. This gate re-derives that from the DB instead of
 * trusting the declaration:
 *
 *   - `hover` was typed `z.string()` while all 12 (dev) / 16 (live) authoring
 *     component_portal nodes — test6829, the test6813 identifying-image portal, among
 *     them — store the BOOLEAN `true`, and the client tests it with
 *     `el.hover === true` (view_mosaic_edit_portal.js:204).
 *   - `section_id` had no `null` member while 4 ontology ddos (rsc36/test6879
 *     tool_transcription roles, component_text_area) store an explicit null —
 *     the same class of client-null bug already pinned for the SQO in
 *     sqo_client_nulls.test.ts.
 *
 * The census case below is the standing tripwire: EVERY ddo_map entry in
 * dd_ontology, key-whitelisted exactly as PHP does, must satisfy ddoSchema.
 *
 * Also gated here: `buildSqoSectionTipoDdos`
 * (src/core/relations/request_config/explicit.ts) stamped a literal
 * `permissions = 3` on every portal TARGET-SECTION ddo, so a caller with
 * read-only on the target still saw "New" / unlink / "Delete resource and all
 * links". PHP stamps `common::get_permissions($section_tipo, $section_tipo)`
 * and derives each button's own level (trait.request_config_utils.php:424,
 * :467).
 */
// Generic-TLD migration 2026-08-20 (AGENTS.md hard rule). Install tipos were replaced
// by their twins (src/core/test_data/test_tld_tipo_map.json); the seed-shipped ones
// (rsc/dd/hierarchy/ontology/lg) ship with every installation and stay, spelled through
// `seed()` so the census can tell a reference from a binding.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Ddo, ddoSchema, sanitizeClientDdoMap } from '../../src/core/concepts/ddo.ts';
import { rqoSchema } from '../../src/core/concepts/rqo.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { buildSqoSectionTipoDdos } from '../../src/core/relations/request_config/explicit.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	getPermissions,
	type Principal,
	resolvePrincipal,
} from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';

/** Seed-shipped tipo, spelled so the census sees a reference, not a binding. */
const seed = <T extends string, N extends number>(tld: T, id: N): `${T}${N}` => `${tld}${id}`;

/**
 * PHP `sanitize_client_ddo_map` $allowed_fields, verbatim and in PHP order
 * (class.request_config_object.php:686-704). The client-echo whitelist IS this
 * list; the schema's key set must equal it exactly.
 */
const PHP_ALLOWED_FIELDS = [
	'typo',
	'tipo',
	'section_tipo',
	'section_id',
	'parent',
	'mode',
	'lang',
	'view',
	'label',
	'fields_separator',
	'records_separator',
	'value_with_parents',
	'column_id',
	'width',
	'in_mosaic',
	'hover',
	'limit',
	'offset',
] as const;

/**
 * NAMED EXEMPTION — the `section_list_thesaurus` dialect.
 *
 * A section_list_thesaurus node's `properties.show.ddo_map` is NOT a wire
 * ddo_map: it is the tree-element descriptor list consumed by ts_object
 * (src/core/ts_object/ts_object.ts:78) and
 * section/list_definitions/section_list_thesaurus.ts, both of which declare
 * their OWN `{tipo, type, icon}` shape and never touch ddoSchema. Two of its
 * entries carry an ARRAY `tipo` (ontology32, rsc1050 — the multi-term tree
 * label), which is meaningless on the RQO wire. It never reaches the client as
 * a ddo_map, so it is excluded from the census — by MODEL, not by shape.
 */
const NON_WIRE_DDO_MAP_MODELS: ReadonlySet<string> = new Set(['section_list_thesaurus']);

interface OntologyDdo {
	owner: string;
	model: string;
	ddo: Record<string, unknown>;
}

/** Every `ddo_map` array anywhere in an ontology node's properties. */
function collectDdoMaps(value: unknown, into: Record<string, unknown>[]): void {
	if (Array.isArray(value)) {
		for (const item of value) collectDdoMaps(item, into);
		return;
	}
	if (value === null || typeof value !== 'object') return;
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (key === 'ddo_map' && Array.isArray(child)) {
			for (const entry of child) {
				if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
					into.push(entry as Record<string, unknown>);
				}
			}
			continue;
		}
		collectDdoMaps(child, into);
	}
}

/** PHP sanitize_client_ddo_map: copy the whitelisted keys, drop everything else. */
function phpWhitelist(ddo: Record<string, unknown>): Record<string, unknown> {
	const clean: Record<string, unknown> = {};
	for (const field of PHP_ALLOWED_FIELDS) {
		if (Object.hasOwn(ddo, field)) clean[field] = ddo[field];
	}
	return clean;
}

let dbReady = false;
/** Every wire-reachable ddo authored in dd_ontology. */
const ontologyDdos: OntologyDdo[] = [];
/** The subset that declares `hover` — the finding's driver. */
const hoverDdos: OntologyDdo[] = [];
let superuser: Principal | null = null;

/*
 * THE AUDIT SCENARIO, as a SCRATCH fixture (nothing pre-existing is mutated).
 * A profile that grants EDIT on the section holding the test6829 portal and only
 * READ on the portal's TARGET section, plus a user assigned to it — exactly the
 * caller whose "New" / unlink / "Delete resource and all links" affordances the
 * old literal `permissions = 3` fabricated. Everything is deleted in afterAll.
 */
const PROFILES_TABLE = 'matrix_profiles';
const PROFILES_SECTION_TIPO = 'dd234';
const USERS_TABLE = 'matrix_users';
const USERS_SECTION_TIPO = 'dd128';
/** The section that OWNS the test6829 portal — the caller edits here. */
const PORTAL_HOST_SECTION = 'test6813';
/** test6829's TARGET section — read-only for this caller. */
const READ_ONLY_TARGET = seed('rsc', 170);
/** Granted nowhere in the fixture profile: level 0. */
const UNGRANTED_SECTION = seed('rsc', 2);
/** Unique per run so a crashed previous run can never collide. */
const RUN_TAG = `ddoperm_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

let scratchProfileId = 0;
let scratchUserId = 0;
let scratchPrincipal: Principal | null = null;

beforeAll(async () => {
	try {
		await sql`SELECT 1`;
		dbReady = true;
	} catch {
		dbReady = false; // no shared DB on this machine — DB-backed cases skip honestly
		return;
	}
	const rows = (await sql`
		SELECT tipo, model, properties
		FROM dd_ontology
		WHERE properties::text LIKE '%ddo_map%'
	`) as { tipo: string; model: string; properties: unknown }[];
	for (const row of rows) {
		if (NON_WIRE_DDO_MAP_MODELS.has(row.model)) continue;
		const found: Record<string, unknown>[] = [];
		collectDdoMaps(row.properties, found);
		for (const ddo of found) {
			const entry: OntologyDdo = { owner: row.tipo, model: row.model, ddo };
			ontologyDdos.push(entry);
			if (Object.hasOwn(ddo, 'hover')) hoverDdos.push(entry);
		}
	}
	superuser = await resolvePrincipal(-1);

	// The scratch profile: EDIT on the portal's host section, READ on its target.
	scratchProfileId = await insertMatrixRecordWithCounter(PROFILES_TABLE, PROFILES_SECTION_TIPO, {
		misc: {
			dd774: [
				{
					id: 1,
					tipo: PORTAL_HOST_SECTION,
					section_tipo: PORTAL_HOST_SECTION,
					value: 2,
				},
				{ id: 2, tipo: READ_ONLY_TARGET, section_tipo: READ_ONLY_TARGET, value: 1 },
			],
		},
		relation: { dd1067: [] },
		data: { label: RUN_TAG, section_tipo: PROFILES_SECTION_TIPO },
	});
	scratchUserId = await insertMatrixRecordWithCounter(USERS_TABLE, USERS_SECTION_TIPO, {
		relation: {
			dd1725: [
				{
					id: 1,
					type: 'dd151',
					section_id: String(scratchProfileId),
					section_tipo: PROFILES_SECTION_TIPO,
					from_component_tipo: 'dd1725',
				},
			],
			dd131: [
				{
					id: 1,
					type: 'dd151',
					section_id: '1',
					section_tipo: 'dd64',
					from_component_tipo: 'dd131',
				},
			],
		},
		data: { label: RUN_TAG, section_tipo: USERS_SECTION_TIPO, created_by_user_id: -1 },
	});
	// Raw inserts fire no save event: drop the per-user security caches by hand.
	clearPermissionsCache();
	clearPrincipalCache();
	scratchPrincipal = await resolvePrincipal(scratchUserId);
});

afterAll(async () => {
	if (!dbReady) return;
	for (const [table, sectionTipo, sectionId] of [
		[USERS_TABLE, USERS_SECTION_TIPO, scratchUserId],
		[PROFILES_TABLE, PROFILES_SECTION_TIPO, scratchProfileId],
	] as [string, string, number][]) {
		if (sectionId <= 0) continue;
		await deleteMatrixRecord(table, sectionTipo, sectionId);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[sectionTipo, sectionId],
		);
	}
	clearPermissionsCache();
	clearPrincipalCache();
});

describe('ddoSchema: the client-echo whitelist', () => {
	test('key set equals the PHP allowed_fields list exactly', () => {
		expect(Object.keys(ddoSchema.shape).sort()).toEqual([...PHP_ALLOWED_FIELDS].sort());
	});

	test('unknown ontology-authored keys are stripped, not rejected', () => {
		const parsed = ddoSchema.safeParse({
			tipo: seed('rsc', 29),
			info: 'Image (component_image)', // ontology authoring comment
			role: 'people_section', // tool ddo_map role
			in_mosaic: true,
		});
		expect(parsed.success).toBe(true);
		expect(parsed.data).toEqual({ tipo: seed('rsc', 29), in_mosaic: true });
	});
});

describe('ddoSchema accepts the value shapes the ontology stores', () => {
	test('boolean hover (the ontology + client shape) is accepted', () => {
		// component_portal test6829 show.ddo_map[0] (rsc20), verbatim.
		const parsed = ddoSchema.safeParse({
			tipo: seed('rsc', 20),
			mode: 'edit',
			view: 'line',
			hover: true,
			parent: 'self',
			section_tipo: 'self',
		});
		expect(parsed.success).toBe(true);
		expect((parsed.data as Ddo | undefined)?.hover).toBe(true);
	});

	test('explicit null section_id (the tool-role ddos) is accepted', () => {
		const parsed = ddoSchema.safeParse({
			tipo: seed('rsc', 197),
			mode: 'list_thesaurus',
			view: 'thesaurus_list',
			section_id: null,
			section_tipo: seed('rsc', 197),
		});
		expect(parsed.success).toBe(true);
	});

	test('an RQO carrying a boolean-hover ddo_map does NOT 400', () => {
		const parsed = rqoSchema.safeParse({
			action: 'read',
			dd_api: 'dd_core_api',
			source: { typo: 'source', type: 'section', tipo: 'test6829', section_tipo: 'test6813' },
			show: {
				ddo_map: [
					{ tipo: seed('rsc', 20), mode: 'edit', view: 'line', hover: true, parent: 'self' },
					{ tipo: seed('rsc', 29), in_mosaic: true, parent: 'self' },
				],
			},
		});
		expect(parsed.success).toBe(true);
	});

	test('sanitizeClientDdoMap keeps a boolean-hover map instead of failing closed to []', () => {
		const clean = sanitizeClientDdoMap([
			{ tipo: seed('rsc', 20), hover: true, parent: 'self' },
			{ tipo: seed('rsc', 29), in_mosaic: true, parent: 'self' },
		]);
		expect(clean.map((ddo) => ddo.tipo)).toEqual([seed('rsc', 20), seed('rsc', 29)]);
		expect(clean[0]?.hover).toBe(true);
	});

	/**
	 * PHP shape-checks exactly these two and DROPS the key on a bad shape
	 * (class.request_config_object.php:723-729) — it never discards the ddo. The
	 * rule is documented in docs/api/dd_object.md ("accepted only as
	 * non-negative integers (any other shape is dropped)"); before this gate the
	 * schema neither dropped nor bounded them.
	 */
	test('limit/offset: non-negative integers survive', () => {
		const parsed = ddoSchema.safeParse({ tipo: seed('rsc', 20), limit: 0, offset: 25 });
		expect(parsed.success).toBe(true);
		expect(parsed.data).toEqual({ tipo: seed('rsc', 20), limit: 0, offset: 25 });
	});

	test('limit/offset: a tampered shape drops the KEY, keeps the ddo', () => {
		for (const bad of ['10', -5, 1.5, null, true]) {
			const parsed = ddoSchema.safeParse({ tipo: seed('rsc', 20), limit: bad, offset: bad });
			expect(parsed.success).toBe(true);
			expect(parsed.data).toEqual({ tipo: seed('rsc', 20) });
		}
	});
});

describe('CENSUS TRIPWIRE: every wire ddo_map in dd_ontology satisfies ddoSchema', () => {
	test('hover is authored as a BOOLEAN in the ontology (non-vacuity floor)', () => {
		if (!dbReady) return;
		expect(hoverDdos.length).toBeGreaterThan(0);
		const types = new Set(hoverDdos.map((entry) => typeof entry.ddo.hover));
		expect([...types]).toEqual(['boolean']);
		// test6829 — the test6813 identifying-image portal named in the audit finding.
		expect(hoverDdos.some((entry) => entry.owner === 'test6829')).toBe(true);
	});

	/**
	 * THE TYPE-DRIFT GATE. Every ddo the ontology authors WITH a tipo — i.e.
	 * every ddo a client can echo back and expect resolved — must satisfy
	 * ddoSchema STRICTLY after the PHP key whitelist. This is what goes red the
	 * next time a declared type stops matching the authored one.
	 */
	test('every tipo-bearing ontology ddo parses after the PHP key whitelist', () => {
		if (!dbReady) return;
		const usable = ontologyDdos.filter((entry) => typeof entry.ddo.tipo === 'string');
		expect(usable.length).toBeGreaterThan(100); // non-vacuity floor
		const failures: string[] = [];
		for (const entry of usable) {
			const parsed = ddoSchema.safeParse(phpWhitelist(entry.ddo));
			if (!parsed.success) {
				failures.push(
					`${entry.owner} (${entry.model}): ${JSON.stringify(phpWhitelist(entry.ddo))} -> ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
				);
			}
		}
		expect(failures).toEqual([]);
	});

	/**
	 * THE RESILIENCE GATE. The ontology also authors ddos NO consumer can use —
	 * a bare `{}` (test188) and tipo-less entries (test6533/1139). PHP keeps
	 * them (they resolve nothing downstream); TS drops them. Neither may take the
	 * SIBLING ddos — or the whole request — down with them.
	 */
	test('a tipo-less ontology ddo is dropped, never fatal to its map', () => {
		if (!dbReady) return;
		const unusable = ontologyDdos.filter((entry) => typeof entry.ddo.tipo !== 'string');
		expect(unusable.length).toBeGreaterThan(0); // non-vacuity floor
		const map = [
			...unusable.map((entry) => phpWhitelist(entry.ddo)),
			{ tipo: seed('rsc', 20), hover: true },
		];
		const clean = sanitizeClientDdoMap(map);
		expect(clean).toEqual([{ tipo: seed('rsc', 20), hover: true }]);
	});

	test('an RQO whose ddo_map holds an unusable entry still parses (no wholesale 400)', () => {
		const parsed = rqoSchema.safeParse({
			action: 'read',
			source: { tipo: 'test6829', section_tipo: 'test6813' },
			show: { ddo_map: [{}, { section_tipo: 'test6099' }, { tipo: seed('rsc', 20), hover: true }] },
		});
		expect(parsed.success).toBe(true);
		expect(parsed.data?.show?.ddo_map).toEqual([{ tipo: seed('rsc', 20), hover: true }]);
	});
});

describe('buildSqoSectionTipoDdos stamps the CALLER permissions, not a literal 3', () => {
	/** test6829's target section (audio-visual resources) — the audit's example. */
	const TARGET = seed('rsc', 170);

	test('no request scope = internal resolution keeps the v0 admin posture (3)', async () => {
		if (!dbReady) return;
		const [ddo] = await buildSqoSectionTipoDdos([TARGET]);
		expect(ddo?.permissions).toBe(3);
	});

	test('superuser gets 3', async () => {
		if (!dbReady || superuser === null) return;
		const [ddo] = await runWithRequestContext(
			{ principal: superuser, session: null, requestId: 'test-ddo-su', clientIp: '' },
			() => buildSqoSectionTipoDdos([TARGET]),
		);
		expect(ddo?.permissions).toBe(3);
	});

	test('THE FINDING: read-only on the portal TARGET = level 1 and NO buttons', async () => {
		if (!dbReady || scratchPrincipal === null) return;
		const principal = scratchPrincipal;
		// Precondition, asserted so the fixture cannot silently stop being the
		// scenario: the caller edits the portal's host section and only reads its
		// target.
		expect(await getPermissions(principal, PORTAL_HOST_SECTION, PORTAL_HOST_SECTION)).toBe(2);
		expect(await getPermissions(principal, READ_ONLY_TARGET, READ_ONLY_TARGET)).toBe(1);

		const [ddo] = await runWithRequestContext(
			{ principal, session: null, requestId: 'test-ddo-target', clientIp: '' },
			() => buildSqoSectionTipoDdos([READ_ONLY_TARGET]),
		);
		expect(ddo?.permissions).toBe(1); // was a literal 3
		// PHP build_section_buttons returns [] at or below read level — no "New",
		// no "Delete resource and all links".
		expect(ddo?.buttons).toEqual([]);
	});

	test('an ungranted target section is level 0 with no buttons', async () => {
		if (!dbReady || scratchPrincipal === null) return;
		const principal = scratchPrincipal;
		expect(await getPermissions(principal, UNGRANTED_SECTION, UNGRANTED_SECTION)).toBe(0);
		const [ddo] = await runWithRequestContext(
			{ principal, session: null, requestId: 'test-ddo-ungranted', clientIp: '' },
			() => buildSqoSectionTipoDdos([UNGRANTED_SECTION]),
		);
		expect(ddo?.permissions).toBe(0);
		expect(ddo?.buttons).toEqual([]);
	});

	test('at edit level the buttons return, each carrying its OWN grant', async () => {
		if (!dbReady || scratchPrincipal === null) return;
		const principal = scratchPrincipal;
		const [ddo] = await runWithRequestContext(
			{ principal, session: null, requestId: 'test-ddo-buttons', clientIp: '' },
			() => buildSqoSectionTipoDdos([PORTAL_HOST_SECTION]),
		);
		expect(ddo?.permissions).toBe(2);
		expect(ddo?.buttons.map((button) => button.model).sort()).toEqual([
			'button_delete',
			'button_new',
		]); // non-vacuity floor: test6813 declares test6822/test6823
		for (const button of ddo?.buttons ?? []) {
			const buttonTipo = await buttonTipoOf(PORTAL_HOST_SECTION, button.model);
			expect(buttonTipo).not.toBe('');
			// PHP stamps the BUTTON's own grant, not the section's literal 3.
			expect(button.permissions).toBe(
				await getPermissions(principal, PORTAL_HOST_SECTION, buttonTipo),
			);
			expect(button.permissions).not.toBe(3);
		}
	});
});

/** The section's button_new/button_delete child tipo (virtual-aware), for the assertion above. */
async function buttonTipoOf(sectionTipo: string, buttonModel: string): Promise<string> {
	const read = async (parent: string) =>
		(await sql`
			SELECT tipo FROM dd_ontology WHERE parent = ${parent} AND model = ${buttonModel} LIMIT 1
		`) as { tipo: string }[];
	let rows = await read(sectionTipo);
	if (rows.length === 0) {
		const nodeRows = (await sql`
			SELECT relations FROM dd_ontology WHERE tipo = ${sectionTipo}
		`) as { relations: { tipo?: unknown }[] | null }[];
		const real = nodeRows[0]?.relations?.[0]?.tipo;
		if (typeof real === 'string') rows = await read(real);
	}
	return rows[0]?.tipo ?? '';
}
