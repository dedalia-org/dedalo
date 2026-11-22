/**
 * THE MAINTENANCE PERSONAS (T2-O15-2) — one user per cell of THE maintenance
 * rule's truth table (security/permissions.ts canAccessMaintenanceArea: the
 * superuser always; a global admin OR a developer whose profile grants dd88 at
 * level 2), so a three-door agreement gate can prove every door answers the
 * same for each:
 *
 *   954001  admin      + dd88 = 2   → OPEN
 *   954002  admin      + no dd88    → closed (the role is no grant)
 *   954003  admin      + dd88 = 1   → closed (read is not the maintenance level)
 *   954004  developer  + dd88 = 2   → OPEN   (Q5: developers too)
 *   954005  developer  + no dd88    → closed
 *   954006  neither    + dd88 = 2   → closed (the grant is no role)
 *
 * Profiles 954011 (dd88 = 2), 954012 (no dd88), 954013 (dd88 = 1); each also
 * grants test3 = 1 so a profile is never empty. Every user's dd1603 "Default
 * section" names dd88, so the no-tipo login landing is asked the same rule. Users and profiles are ordinary
 * dd128 / dd234 records at EXPLICIT ids in the scratch band (no counter touched);
 * no ontology node. Install is idempotent (a crashed run's rows are swept
 * first); the sweep THROWS on a 0-row delete. Both refuse a database without
 * the suite marker.
 */

import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

export interface MaintenancePersona {
	userId: number;
	label: string;
	/** What THE maintenance rule must answer for this persona. */
	open: boolean;
}

const PROFILE_GRANT_2 = 954011;
const PROFILE_NO_GRANT = 954012;
const PROFILE_GRANT_1 = 954013;

const PERSONA_ROWS: readonly (MaintenancePersona & {
	admin: boolean;
	developer: boolean;
	profile: number;
})[] = [
	{
		userId: 954001,
		label: 'admin + dd88 2',
		open: true,
		admin: true,
		developer: false,
		profile: PROFILE_GRANT_2,
	},
	{
		userId: 954002,
		label: 'admin, no grant',
		open: false,
		admin: true,
		developer: false,
		profile: PROFILE_NO_GRANT,
	},
	{
		userId: 954003,
		label: 'admin + dd88 1',
		open: false,
		admin: true,
		developer: false,
		profile: PROFILE_GRANT_1,
	},
	{
		userId: 954004,
		label: 'developer + dd88 2',
		open: true,
		admin: false,
		developer: true,
		profile: PROFILE_GRANT_2,
	},
	{
		userId: 954005,
		label: 'developer, no grant',
		open: false,
		admin: false,
		developer: true,
		profile: PROFILE_NO_GRANT,
	},
	{
		userId: 954006,
		label: 'no role + dd88 2',
		open: false,
		admin: false,
		developer: false,
		profile: PROFILE_GRANT_2,
	},
];

/** A non-superuser global admin who passes the maintenance rule (dd88 = 2). */
export const MAINTENANCE_ADMIN_USER_ID = 954001;

/** The personas (the superuser is the caller's own row: −1, always open). */
export const MAINTENANCE_PERSONAS: readonly MaintenancePersona[] = PERSONA_ROWS.map(
	({ userId, label, open }) => ({ userId, label, open }),
);

const PROFILE_GRANTS: readonly { id: number; dd88: number | null }[] = [
	{ id: PROFILE_GRANT_2, dd88: 2 },
	{ id: PROFILE_NO_GRANT, dd88: null },
	{ id: PROFILE_GRANT_1, dd88: 1 },
];

const OWNED: readonly { table: string; sectionTipo: string; sectionId: number }[] = [
	...PERSONA_ROWS.map((row) => ({
		table: 'matrix_users',
		sectionTipo: 'dd128',
		sectionId: row.userId,
	})),
	...PROFILE_GRANTS.map((row) => ({
		table: 'matrix_profiles',
		sectionTipo: 'dd234',
		sectionId: row.id,
	})),
];

const SCRATCH_ID_FLOOR = 900000;

function assertScratchIds(): void {
	for (const record of OWNED) {
		if (!Number.isInteger(record.sectionId) || record.sectionId < SCRATCH_ID_FLOOR) {
			throw new Error(
				`maintenance_persona_fixture: ${record.table} id ${record.sectionId} is below the scratch floor`,
			);
		}
	}
}

/** A yes/no flag (dd64: 1 = Yes, 2 = No) or a record locator, as real user rows carry them. */
function locator(componentTipo: string, sectionTipo: string, sectionId: number) {
	return {
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

async function insert(
	table: string,
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown>,
): Promise<void> {
	const entries = Object.entries(columns);
	const names = entries.map(([name]) => `"${name}"`).join(', ');
	const values = entries.map((_, index) => `$${index + 3}::text::jsonb`).join(', ');
	await sql.unsafe(
		`INSERT INTO "${table}" (section_tipo, section_id, ${names}) VALUES ($1, $2, ${values})`,
		[sectionTipo, sectionId, ...entries.map(([, value]) => encodeForJsonb(value))],
	);
}

function clearCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
}

async function purge(strict: boolean): Promise<void> {
	assertScratchIds();
	const missing: string[] = [];
	for (const record of OWNED) {
		const removed = await deleteMatrixRecord(record.table, record.sectionTipo, record.sectionId);
		if (removed === 0) missing.push(`${record.table}/${record.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[record.sectionTipo, record.sectionId],
		);
	}
	if (strict && missing.length > 0) {
		throw new Error(`maintenance_persona_fixture sweep removed 0 rows for: ${missing.join(', ')}`);
	}
}

/** Mint the personas (idempotent). */
export async function installMaintenancePersonas(): Promise<void> {
	await assertTestDatabase('installMaintenancePersonas');
	await purge(false);
	for (const profile of PROFILE_GRANTS) {
		const dd774: Record<string, unknown>[] = [
			{ id: 1, tipo: 'test3', section_tipo: 'test3', value: 1 },
		];
		if (profile.dd88 !== null) {
			dd774.push({ id: 2, tipo: 'dd88', section_tipo: 'dd88', value: profile.dd88 });
		}
		await insert('matrix_profiles', 'dd234', profile.id, {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: `zzmaint profile ${profile.id}` }] },
			misc: { dd774 },
		});
	}
	for (const row of PERSONA_ROWS) {
		await insert('matrix_users', 'dd128', row.userId, {
			string: {
				dd132: [{ id: 1, lang: 'lg-nolan', value: `zzmaint_${row.userId}` }],
				// dd1603 "Default section" = Maintenance: the login landing is a door too
				dd1603: [{ id: 1, lang: 'lg-nolan', value: 'dd88' }],
			},
			relation: {
				dd131: [locator('dd131', 'dd64', 1)],
				dd244: [locator('dd244', 'dd64', row.admin ? 1 : 2)],
				dd515: [locator('dd515', 'dd64', row.developer ? 1 : 2)],
				dd1725: [locator('dd1725', 'dd234', row.profile)],
			},
		});
	}
	clearCaches();
}

/** Sweep every row the fixture owns (throws on a 0-row delete). */
export async function removeMaintenancePersonas(): Promise<void> {
	await assertTestDatabase('removeMaintenancePersonas');
	await purge(true);
	clearCaches();
}
