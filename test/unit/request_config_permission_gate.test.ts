/**
 * Per-component READ permission gates — the AUTHZ hole closed 2026-07-10:
 * a non-admin with section-level read but a level-0 grant on specific
 * components received those components' CONTEXT and DATA, including via a
 * crafted client show.ddo_map (read.ts honors it verbatim, so any component
 * tipo inside an authorized section was harvestable).
 *
 * PHP contract mirrored: check_ddo_permissions
 * (trait.request_config_ddo.php:381-92, step 11 — section-owned configs only)
 * + filter_authorized_related (trait.request_config_v5.php:574-86, STEP 5 of
 * the implicit pipeline) + the emission backstop in section/read.ts (both the
 * context loop and the readSectionRows data map).
 *
 * Fixture: the SYNTHETIC non-admin of test/helpers/acl_identity_fixture.ts,
 * BUILT here (install/remove in beforeAll/afterAll). It used to be "user 16,
 * profile 8, the real non-admin of the shared mib DB" — an installation's
 * account that a rebuilt suite database does not hold, so resolvePrincipal
 * returned a grantless principal, the discovery loop found no pair, and the
 * non-vacuity floor reported the fixture's absence rather than the engine's
 * behaviour. The (section, denied component, granted component) triple is
 * still DISCOVERED from the dd774 matrix + the section's derived list map (so
 * the gate stays drift-tolerant), and the floor still FAILS when no denied
 * pair exists — it just now has something real to find.
 *
 * Oracle honesty note: the PHP behavior is pinned by the trait anchors above;
 * this gate runs against the permission matrix the engine actually reads.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Rqo } from '../../src/core/concepts/rqo.ts';
import { isConsultationOnlySection } from '../../src/core/concepts/section.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { ElementNodeRegistry } from '../../src/core/relations/element_registry.ts';
import {
	buildGetDataContext,
	deriveSectionDdoMap,
	readSection,
} from '../../src/core/section/read.ts';
import {
	ddoIsAuthorized,
	getPermissions,
	getSectionPermissions,
	type Principal,
	resolvePrincipal,
	resolveProfileId,
} from '../../src/core/security/permissions.ts';
import { runWithRequestContext } from '../../src/core/security/request_context.ts';
import {
	ACL_NON_ADMIN_USER_ID,
	installAclIdentityFixture,
	removeAclIdentityFixture,
} from '../helpers/acl_identity_fixture.ts';

const NON_ADMIN_USER = ACL_NON_ADMIN_USER_ID;

let dbReady = false;
let nonAdmin: Principal;
let admin: Principal;
// Discovered triple: a section user 16 can READ whose derived list map holds
// at least one DENIED component (level 0) and one GRANTED component (>= 1).
let sectionTipo: string | null = null;
let deniedTipo: string | null = null;
let grantedTipo: string | null = null;
/** The MODE whose derived map holds the discovered pair (see the loop below). */
let readMode: 'list' | 'edit' = 'list';

beforeAll(async () => {
	try {
		await sql`SELECT 1`;
		dbReady = true;
	} catch {
		dbReady = false; // no shared DB on this machine — DB-backed cases skip honestly
		return;
	}
	await installAclIdentityFixture();
	nonAdmin = await resolvePrincipal(NON_ADMIN_USER);
	admin = await resolvePrincipal(-1);
	// The profile the ENGINE resolves for this user — never a hard-coded id.
	const profileId = await resolveProfileId(NON_ADMIN_USER);
	const rows = (await sql`
		SELECT misc->'dd774' AS grants FROM matrix_profiles
		WHERE section_tipo = 'dd234' AND section_id = ${profileId}
	`) as { grants: { tipo: string; section_tipo: string; value: number }[] }[];
	const grants = rows[0]?.grants ?? [];
	const readableSections = grants
		.filter((grant) => grant.tipo === grant.section_tipo && grant.value >= 1)
		.map((grant) => grant.section_tipo);
	// Both modes: a section's LIST map is a small subset of its edit map, so a
	// granted component may only appear in one of them — and the assertions read
	// in the SAME mode the pair was discovered in, or "context contains the
	// granted tipo" would fail for a reason that is not the permission gate.
	const candidates: { section: string; mode: 'list' | 'edit' }[] = [];
	for (const section of readableSections) {
		for (const mode of ['list', 'edit'] as const) candidates.push({ section, mode });
	}
	for (const { section: candidate, mode } of candidates) {
		const map = await deriveSectionDdoMap(candidate, candidate, mode);
		let denied: string | null = null;
		let granted: string | null = null;
		for (const ddo of map) {
			const gateSection = Array.isArray(ddo.section_tipo)
				? ddo.section_tipo[0]
				: ddo.section_tipo === 'self' || ddo.section_tipo === undefined
					? candidate
					: ddo.section_tipo;
			if (gateSection === undefined) continue;
			const level = await getPermissions(nonAdmin, gateSection, ddo.tipo);
			if (level === 0 && denied === null) denied = ddo.tipo;
			if (level >= 1 && granted === null) granted = ddo.tipo;
			if (denied !== null && granted !== null) break;
		}
		if (denied !== null && granted !== null) {
			sectionTipo = candidate;
			deniedTipo = denied;
			grantedTipo = granted;
			readMode = mode;
			break;
		}
	}
});

afterAll(async () => {
	if (dbReady) await removeAclIdentityFixture();
});

function asUser16<T>(fn: () => Promise<T>): Promise<T> {
	return runWithRequestContext(
		{ principal: nonAdmin, session: null, requestId: 'perm_gate_test', clientIp: '127.0.0.1' },
		fn,
	);
}

function readRqo(section: string, ddoMap: unknown[] = []): Rqo {
	return {
		id: 'perm_gate',
		action: 'read',
		dd_api: 'dd_core_api',
		prevent_lock: true,
		options: {},
		source: {
			typo: 'source',
			type: 'section',
			action: 'read',
			model: 'section',
			tipo: section,
			section_tipo: section,
			mode: readMode,
			lang: 'lg-spa',
		},
		show: { ddo_map: ddoMap, fields_separator: ' | ', columns: [] },
		sqo: { id: 'tmp', section_tipo: [section], limit: 1, offset: 0 },
	} as unknown as Rqo;
}

describe('per-component permission gates (AUTHZ, 2026-07-10)', () => {
	test('a denied/granted component pair exists on the live matrix (non-vacuity floor)', () => {
		if (!dbReady) return;
		// If this fails, the fixture profile changed — the gate must be re-aimed,
		// not skipped: without a denied pair every assertion below is vacuous.
		expect(sectionTipo).not.toBeNull();
		expect(deniedTipo).not.toBeNull();
		expect(grantedTipo).not.toBeNull();
	});

	test('ddoIsAuthorized mirrors the matrix (denied 0 → false, granted ≥1 → true, admin → true)', async () => {
		if (!dbReady || sectionTipo === null) return;
		expect(await ddoIsAuthorized(nonAdmin, sectionTipo, deniedTipo as string)).toBe(false);
		expect(await ddoIsAuthorized(nonAdmin, sectionTipo, grantedTipo as string)).toBe(true);
		expect(await ddoIsAuthorized(admin, sectionTipo, deniedTipo as string)).toBe(true);
		expect(await ddoIsAuthorized(undefined, sectionTipo, deniedTipo as string)).toBe(true);
	});

	test('non-admin read DROPS the denied component from context AND data (server-derived map)', async () => {
		if (!dbReady || sectionTipo === null) return;
		const result = await asUser16(() => readSection(readRqo(sectionTipo as string), nonAdmin));
		const contextTipos = result.context.map((entry) => (entry as { tipo?: string }).tipo);
		expect(contextTipos).not.toContain(deniedTipo as string);
		expect(contextTipos).toContain(grantedTipo as string);
		const dataTipos = result.data.map((item) => (item as { tipo?: string }).tipo);
		expect(dataTipos).not.toContain(deniedTipo as string);
	});

	test('client-map bypass vector is CLOSED: naming the denied tipo in show.ddo_map still omits it', async () => {
		if (!dbReady || sectionTipo === null) return;
		const craftedMap = [
			{
				tipo: deniedTipo,
				section_tipo: sectionTipo,
				parent: sectionTipo,
				mode: readMode,
			},
			{
				tipo: grantedTipo,
				section_tipo: sectionTipo,
				parent: sectionTipo,
				mode: readMode,
			},
		];
		const result = await asUser16(() =>
			readSection(readRqo(sectionTipo as string, craftedMap), nonAdmin),
		);
		const contextTipos = result.context.map((entry) => (entry as { tipo?: string }).tipo);
		expect(contextTipos).not.toContain(deniedTipo as string);
		expect(contextTipos).toContain(grantedTipo as string);
		const dataTipos = result.data.map((item) => (item as { tipo?: string }).tipo);
		expect(dataTipos).not.toContain(deniedTipo as string);
	});

	test('admin control: the same read as admin still carries the denied tipo (no over-drop)', async () => {
		if (!dbReady || sectionTipo === null) return;
		const result = await readSection(readRqo(sectionTipo as string), admin);
		const contextTipos = result.context.map((entry) => (entry as { tipo?: string }).tipo);
		expect(contextTipos).toContain(deniedTipo as string);
		expect(contextTipos).toContain(grantedTipo as string);
	});

	// ---- per-element permission STAMPS (2026-07-18: the client renders <1
	// ---- hidden / 1 read-only / >1 editable from exactly this field, so a
	// ---- coarse stamp let users open editors that 403 on save).

	/** The read-target consultation-only cap readSection applies to its stamps. */
	function capped(level: number, section: string): number {
		return level > 1 && isConsultationOnlySection(section) ? 1 : level;
	}

	test('context stamps the EXACT matrix level per element (no coarse 3/1 stamp)', async () => {
		if (!dbReady || sectionTipo === null) return;
		const section = sectionTipo as string;
		const result = await asUser16(() => readSection(readRqo(section), nonAdmin));
		// the granted component carries ITS OWN matrix level — a level-2 grant
		// must stamp 2 (editable), a level-1 grant must stamp 1 (read-only)
		const grantedLevel = await getPermissions(nonAdmin, section, grantedTipo as string);
		const grantedEntry = result.context.find(
			(entry) => (entry as { tipo?: string }).tipo === grantedTipo,
		) as { permissions?: number } | undefined;
		expect(grantedEntry).toBeDefined();
		expect(grantedEntry?.permissions).toBe(capped(grantedLevel, section));
		// the section's own entry carries the section-level ACL
		const sectionEntry = result.context.find(
			(entry) => (entry as { tipo?: string }).tipo === section,
		) as { permissions?: number } | undefined;
		expect(sectionEntry?.permissions).toBe(
			capped(await getSectionPermissions(nonAdmin, section), section),
		);
	});

	test('global-admin FLAG grants no bypass: matrix levels + level-0 drop (PHP parity)', async () => {
		if (!dbReady || sectionTipo === null) return;
		const section = sectionTipo as string;
		const flaggedAdmin: Principal = {
			userId: NON_ADMIN_USER,
			isGlobalAdmin: true,
			isDeveloper: false,
		};
		// the drop gate follows the matrix, not the flag
		expect(await ddoIsAuthorized(flaggedAdmin, section, deniedTipo as string)).toBe(false);
		const result = await runWithRequestContext(
			{
				principal: flaggedAdmin,
				session: null,
				requestId: 'perm_gate_test_admin',
				clientIp: '127.0.0.1',
			},
			() => readSection(readRqo(section), flaggedAdmin),
		);
		const contextTipos = result.context.map((entry) => (entry as { tipo?: string }).tipo);
		expect(contextTipos).not.toContain(deniedTipo as string);
		expect(contextTipos).toContain(grantedTipo as string);
		const dataTipos = result.data.map((item) => (item as { tipo?: string }).tipo);
		expect(dataTipos).not.toContain(deniedTipo as string);
		// the surviving entry is matrix-stamped, not flat 3
		const grantedEntry = result.context.find(
			(entry) => (entry as { tipo?: string }).tipo === grantedTipo,
		) as { permissions?: number } | undefined;
		expect(grantedEntry?.permissions).toBe(
			capped(await getPermissions(flaggedAdmin, section, grantedTipo as string), section),
		);
	});

	test('get_data context: matrix level on the MAIN entry, denied child floored to read', async () => {
		if (!dbReady || sectionTipo === null) return;
		const section = sectionTipo as string;
		const mainLevel = await getPermissions(nonAdmin, section, grantedTipo as string);
		const getDataRqo = {
			id: 'perm_gate_gd',
			action: 'read',
			dd_api: 'dd_core_api',
			prevent_lock: true,
			options: {},
			source: {
				typo: 'source',
				type: 'element',
				action: 'get_data',
				tipo: grantedTipo,
				section_tipo: section,
				section_id: 1,
				mode: 'edit',
				lang: 'lg-spa',
			},
		} as unknown as Rqo;
		// a subdatum item whose OWN grant is 0, expanded through the granted
		// component: PHP get_subdatum floors it to read (1), never hides it
		const deniedChildItem = {
			typo: 'dd',
			tipo: deniedTipo,
			section_tipo: section,
			section_id: '1',
			mode: 'edit',
			lang: 'lg-spa',
			from_component_tipo: grantedTipo,
			value: [],
		} as never;
		const context = await asUser16(() =>
			buildGetDataContext(
				getDataRqo,
				{ items: [deniedChildItem], nodes: new ElementNodeRegistry() },
				nonAdmin,
			),
		);
		const mainEntry = context.find((entry) => entry.tipo === grantedTipo);
		expect(mainEntry?.permissions).toBe(mainLevel);
		const childEntry = context.find((entry) => entry.tipo === deniedTipo);
		expect(childEntry?.permissions).toBe(1);
	});
});
