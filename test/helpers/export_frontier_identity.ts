/**
 * THE EXPORT-FRONTIER IDENTITY — a scoped (non-admin) user and a global admin,
 * their two profiles and two projects, for the T0-1 export-frontier gates
 * (export_frontier_fanout_native, export_leaf_label_grant_native).
 *
 * Shape copied from frontier_class_native.test.ts (the class gate's identity):
 *   - the SCOPED user is in MY project only; the admin flag is present-but-
 *     negative, so `resolvePrincipal` would agree with the literal below;
 *   - the scoped profile's grants are SETTABLE (`setScopedGrants`), because a
 *     gate proves a component key by flipping one grant, not by building a
 *     second identity;
 *   - every row this module writes is at an EXPLICIT id it owns, swept by
 *     (section_tipo, section_id) with a throw-if-nothing-deleted on the strict
 *     sweep. Isolation is the suite DATABASE (dedalo_test_marker) — the ids are
 *     ownership, not a "clear band".
 *
 * Writes only after `assertTestDatabase` (test_db_marker_tripwire).
 */

import { encodeForJsonb } from '../../src/core/db/json_codec.ts';
import { deleteMatrixRecord } from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import { clearUserFilterRecordsCache } from '../../src/core/security/filter_records.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	type Principal,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
const YES_NO_SECTION = 'dd64';

/** One dd774 grant row: `level` on `tipo` of `sectionTipo`. */
export interface FrontierGrant {
	readonly sectionTipo: string;
	readonly tipo: string;
	readonly level: number;
}

export interface ExportFrontierIdentity {
	readonly scoped: Principal;
	readonly admin: Principal;
	readonly myProject: number;
	readonly otherProject: number;
	/** The filter locator a gated record carries to sit in `project`. */
	filterLocator(filterTipo: string, project: number): Record<string, unknown>;
	/** `adminGrants`: the admin profile's dd774 (a global admin still passes the
	 * tool's per-section gate on a profile grant). */
	install(grants: readonly FrontierGrant[], adminGrants: readonly FrontierGrant[]): Promise<void>;
	/** Rewrite the scoped profile's dd774 and drop the permission caches. */
	setScopedGrants(grants: readonly FrontierGrant[]): Promise<void>;
	remove(strict: boolean): Promise<void>;
}

const locator = (
	componentTipo: string,
	sectionTipo: string,
	sectionId: number,
	type = 'dd151',
) => ({
	id: 1,
	type,
	section_id: sectionId,
	section_tipo: sectionTipo,
	from_component_tipo: componentTipo,
});

/** Drop every permission-derived cache the frontier keys read. */
export function clearFrontierIdentityCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
	clearUserFilterRecordsCache();
}

async function insertRow(
	table: string,
	sectionTipo: string,
	sectionId: number,
	columns: Record<string, unknown>,
): Promise<void> {
	const names = ['"section_tipo"', '"section_id"'];
	const placeholders = ['$1', '$2'];
	const params: (string | number)[] = [sectionTipo, sectionId];
	let index = 3;
	for (const [column, value] of Object.entries(columns)) {
		names.push(`"${column}"`);
		placeholders.push(`$${index}::text::jsonb`);
		params.push(encodeForJsonb(value));
		index++;
	}
	await sql.unsafe(
		`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${placeholders.join(', ')})`,
		params,
	);
}

const dd774 = (grants: readonly FrontierGrant[]) =>
	grants.map((grant, index) => ({
		id: index + 1,
		tipo: grant.tipo,
		section_tipo: grant.sectionTipo,
		value: grant.level,
	}));

/**
 * Build one identity at `baseId + 1 … + 22`. Each gate file passes its OWN
 * base so two files never sweep each other's rows.
 */
export function exportFrontierIdentity(name: string, baseId: number): ExportFrontierIdentity {
	const scopedUser = baseId + 1;
	const adminUser = baseId + 2;
	const scopedProfile = baseId + 11;
	const adminProfile = baseId + 12;
	const myProject = baseId + 21;
	const otherProject = baseId + 22;
	const owned = [
		{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: scopedUser },
		{ table: 'matrix_users', sectionTipo: USERS_SECTION, sectionId: adminUser },
		{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: scopedProfile },
		{ table: 'matrix_profiles', sectionTipo: PROFILES_SECTION, sectionId: adminProfile },
		{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: myProject },
		{ table: 'matrix_projects', sectionTipo: PROJECTS_SECTION, sectionId: otherProject },
	];

	const remove = async (strict: boolean): Promise<void> => {
		await assertTestDatabase('exportFrontierIdentity.remove');
		const missing: string[] = [];
		for (const record of owned) {
			const removed = await deleteMatrixRecord(record.table, record.sectionTipo, record.sectionId);
			if (removed === 0) missing.push(`${record.table}/${record.sectionTipo}/${record.sectionId}`);
			await sql.unsafe(
				'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
				[record.sectionTipo, record.sectionId],
			);
		}
		clearFrontierIdentityCaches();
		if (strict && missing.length > 0) {
			throw new Error(
				`${name}: the identity sweep deleted NOTHING for ${missing.join(', ')} — a filter that matches nothing is the bug, not a clean tree`,
			);
		}
	};

	return {
		scoped: { userId: scopedUser, isGlobalAdmin: false, isDeveloper: false },
		admin: { userId: adminUser, isGlobalAdmin: true, isDeveloper: false },
		myProject,
		otherProject,
		filterLocator: (filterTipo, project) => locator(filterTipo, PROJECTS_SECTION, project, 'dd675'),
		remove,
		async install(grants, adminGrants) {
			await assertTestDatabase('exportFrontierIdentity.install');
			await remove(false); // a crashed previous run
			for (const projectId of [myProject, otherProject]) {
				await insertRow('matrix_projects', PROJECTS_SECTION, projectId, {
					string: { dd156: [{ id: 1, lang: 'lg-eng', value: `${name} project ${projectId}` }] },
				});
			}
			await insertRow('matrix_profiles', PROFILES_SECTION, scopedProfile, {
				string: { dd237: [{ id: 1, lang: 'lg-eng', value: `${name} scoped profile` }] },
				misc: { dd774: dd774(grants) },
			});
			await insertRow('matrix_profiles', PROFILES_SECTION, adminProfile, {
				string: { dd237: [{ id: 1, lang: 'lg-eng', value: `${name} admin profile` }] },
				misc: { dd774: dd774(adminGrants) },
			});
			const user = (profileId: number, adminFlag: number, login: string) => ({
				string: { dd132: [{ id: 1, lang: 'lg-nolan', value: login }] },
				relation: {
					dd131: [locator('dd131', YES_NO_SECTION, 1)],
					dd244: [locator('dd244', YES_NO_SECTION, adminFlag)],
					dd515: [locator('dd515', YES_NO_SECTION, 2)],
					dd1725: [locator('dd1725', PROFILES_SECTION, profileId)],
					dd170: [locator('dd170', PROJECTS_SECTION, myProject)],
				},
			});
			await insertRow(
				'matrix_users',
				USERS_SECTION,
				scopedUser,
				user(scopedProfile, 2, `${name}_scoped`),
			);
			await insertRow(
				'matrix_users',
				USERS_SECTION,
				adminUser,
				user(adminProfile, 1, `${name}_admin`),
			);
			clearFrontierIdentityCaches();
		},
		async setScopedGrants(grants) {
			await assertTestDatabase('exportFrontierIdentity.setScopedGrants');
			const updated = (await sql.unsafe(
				`UPDATE "matrix_profiles" SET "misc" = $1::text::jsonb
				 WHERE section_tipo = $2 AND section_id = $3 RETURNING section_id`,
				[encodeForJsonb({ dd774: dd774(grants) }), PROFILES_SECTION, scopedProfile],
			)) as unknown[];
			if (updated.length !== 1) {
				throw new Error(
					`${name}: the scoped profile is missing — every grant probe would be vacuous`,
				);
			}
			clearFrontierIdentityCaches();
		},
	};
}
