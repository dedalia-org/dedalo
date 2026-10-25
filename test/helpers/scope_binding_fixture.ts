/**
 * THE SCOPE-BINDING FIXTURE — the situation the P1-24 behavioural gates build
 * (action_scope_binding_native, preset_ownership_native).
 *
 * WHY IT EXISTS. The audit's CARRY-08 doors were proven open with a principal
 * that HELD the grant each action declared (write on `options.section_tipo`)
 * and held NOTHING on the target the action wrote. A gate that only ever runs
 * as the superuser cannot tell the two apart — root passes every level check
 * before the matrix is consulted. So the gates mint two non-admin identities
 * whose grants are DISJOINT on exactly the axis each door confused (every
 * id is ALLOCATED at install and read from the returned handle):
 *
 *   userA       matrix_users     USER A   dd244 → dd64/2 (No), dd515 → No,
 *                                     dd1725 → dd234/profileA,
 *                                     dd170 → dd153/projectOfA (A's OWN project)
 *   userB       matrix_users     USER B   same flags, dd1725 → dd234/profileB,
 *                                     dd170 → dd153/<the default project>
 *   profileA    matrix_profiles  A's profile — misc.dd774: test3 = 2,
 *                                     test3.test52 = 2, test3.test99 = 2,
 *                                     test3.test80 = 2 (the portal a path
 *                                     search hops through and an import
 *                                     links through). NOTHING on test65,
 *                                     NOTHING on hierarchy1.
 *   profileB    matrix_profiles  B's profile — misc.dd774: hierarchy1 = 2,
 *                                     test3 = 2, test3.test52 = 2,
 *                                     test3.test99 = 2, test3.test80 = 2,
 *                                     and READ ONLY on
 *                                     test65 = 1 / test65.test52 = 1 (the
 *                                     level a write action must refuse).
 *   projectOfA  matrix_projects  A's project (dd153) — what puts a record A
 *                                  creates inside A's scope and outside B's;
 *                                  B's records ride the default project, so
 *                                  the two scopes are DISJOINT on test3.
 *           Both profiles carry dd1067 locators for the three tools the
 *           probes dispatch (resolved by NAME from the active registry).
 *   hierarchyId matrix_hierarchy_main  ONE hierarchy1 record (target test3,
 *                                  servable shape copied from the real rows)
 *                                  — the record the hierarchy door PINS.
 *   presetOfA   matrix_list      dd655 editing preset OWNED BY A (dd654 → dd128/A,
 *                                  data.created_by_user_id = A)
 *   presetOfB   matrix_list      dd655 editing preset OWNED BY B
 *   presetSplit matrix_list      dd655 preset with the two owner arms SPLIT:
 *                                  dd654 → A, created_by_user_id = B
 *
 * So: A holds the DECLARED-BUT-WRONG grant at each door (test3 write) and 0 on
 * the real target (test65 / hierarchy1); B is the positive control for the
 * hierarchy door and holds the READ-ONLY grant a write action must refuse; A
 * and B are each other's non-owner for the preset rows and each other's
 * out-of-scope creator on test3 (the record axis: a record B creates is one A
 * cannot reach, whatever A's section grant says).
 *
 * EVERY ID IS ALLOCATED, PER INSTANCE (2026-10-25). The ids used to be fixed
 * constants (946001…), so two copies of one gate on ONE suite database swept
 * each other's fixture mid-run. Now each install mints its records through the
 * engine's own allocator (`insertMatrixRecordWithCounter`, the counter door
 * every real record is born through) and returns them in a
 * {@link ScopeBindingFixture} handle; `removeScopeBindingFixture(handle)` sweeps
 * exactly those rows, strictly (a 0-row delete throws), plus their TM rows. No id
 * band is reserved or assumed — ISOLATION IS THE DATABASE AND ITS MARKER: the
 * `dedalo_test_marker` row must be present before anything is written. Names
 * carry a per-instance token, so two live instances never share a label either.
 * An install that fails midway sweeps what it wrote before rethrowing. A run
 * killed between install and remove leaves its rows behind (attributable by the
 * `zzsb` token in their names); `bun run test:db:setup` rebuilds the database.
 * The per-user security + tool caches are dropped on install and remove.
 */

import { config } from '../../src/config/config.ts';
import {
	deleteMatrixRecord,
	insertMatrixRecordWithCounter,
} from '../../src/core/db/matrix_write.ts';
import { sql } from '../../src/core/db/postgres.ts';
import {
	clearPermissionsCache,
	clearPrincipalCache,
	clearUserProjectsCache,
	FILTER_MASTER_COMPONENT,
	PRESET_OWNER_COMPONENT,
	TEMP_PRESET_SECTION,
} from '../../src/core/security/permissions.ts';
import { assertTestDatabase } from '../../src/core/test_data/test_database_marker.ts';
import { invalidateAllToolCaches } from '../../src/core/tools/cache.ts';

// --- the handle --------------------------------------------------------------

/** The ids ONE install allocated — read every id from here, never a constant. */
export interface ScopeBindingFixture {
	readonly userA: number;
	readonly userB: number;
	readonly profileA: number;
	readonly profileB: number;
	/** The one hierarchy1 record — what tool_hierarchy's writer is pinned to. */
	readonly hierarchyId: number;
	/** dd655 editing presets, one per user. */
	readonly presetOfA: number;
	readonly presetOfB: number;
	/**
	 * A preset whose dd654 OWNER is A but whose `created_by_user_id` is B — the
	 * two arms of the owner predicate split apart, so each can be proven to
	 * reach on its own (A sees it by the locator arm, B by the creator arm).
	 */
	readonly presetSplit: number;
	/**
	 * A's OWN project (dd153). A record created by A is born with it
	 * (record_defaults.ts: a non-admin's FIRST project), B's records with the
	 * default project — so on a projects-filtered section (test3) each user's
	 * records are outside the other's scope.
	 */
	readonly projectOfA: number;
	/** Every row this instance wrote, in write order — exactly what remove sweeps. */
	readonly records: readonly OwnedRecord[];
}

interface OwnedRecord {
	table: string;
	sectionTipo: string;
	sectionId: number;
}

/** The section A and B both hold write on — the DECLARED grant at each door. */
export const SB_GRANTED_SECTION = 'test3';
/** A component of it both profiles grant at level 2 (test3's input_text). */
export const SB_GRANTED_COMPONENT = 'test52';
/** test3's component_image — the media component an import writes (both profiles: 2). */
export const SB_MEDIA_COMPONENT = 'test99';
/** test3's component_portal — the hop a path search takes out of test3, the portal an import links through (both: 2). */
export const SB_HOP_COMPONENT = 'test80';
/**
 * test3's NON-translatable input_text — the import's role write (both: 2). Granted
 * so the component door ADMITS the pair and the only refusal left for A on B's
 * record is the SCOPE (perm.out_of_scope): ungranted, the door refused first
 * (perm.denied) and the scope probe went unasked.
 */
export const SB_INPUT_COMPONENT = 'test162';
/**
 * A test-TLD section A holds NOTHING on — the real target A must be refused
 * on — and B holds READ ONLY (test65 = 1, test65.test52 = 1): the level a
 * write action (minLevel 2) must refuse and a read action (minLevel 1) admits.
 */
export const SB_DENIED_SECTION = 'test65';
/** The hierarchy section — granted to B only. */
export const SB_HIERARCHY_SECTION = 'hierarchy1';

/** The tools the probes dispatch as A/B (granted through dd1067 by name). */
export const SB_GRANTED_TOOLS = [
	'tool_update_cache',
	'tool_hierarchy',
	'tool_import_files',
] as const;

const USERS_SECTION = 'dd128';
const PROFILES_SECTION = 'dd234';
const PROJECTS_SECTION = 'dd153';
/** dd156 — the project NAME component. */
const PROJECT_NAME_COMPONENT = 'dd156';
const YES_NO_SECTION = 'dd64';
const TOOLS_REGISTER_SECTION = 'dd1324';
const YES = 1;
const NO = 2;

/** A dd151-typed locator as the real rows carry it. */
function locator(componentTipo: string, sectionTipo: string, sectionId: number) {
	return {
		id: 1,
		type: 'dd151',
		section_id: sectionId,
		section_tipo: sectionTipo,
		from_component_tipo: componentTipo,
	};
}

/**
 * The dd1324 registry ids of the granted tools, resolved BY NAME through the
 * registry's own door (a pinned id is a bet on one database's seed order).
 * An always_active tool needs no grant and is skipped.
 */
async function grantedToolLocators(): Promise<Record<string, unknown>[]> {
	const { getActiveToolMetaBySectionId } = await import('../../src/core/tools/registry.ts');
	const registry = await getActiveToolMetaBySectionId();
	const locators: Record<string, unknown>[] = [];
	let id = 1;
	for (const name of SB_GRANTED_TOOLS) {
		const matches = [...registry.entries()].filter(([, meta]) => meta.name === name);
		if (matches.length !== 1) {
			throw new Error(
				`scope_binding_fixture: the ACTIVE tool registry holds ${matches.length} rows named '${name}' (expected 1) — build the suite DB with 'bun run test:db:setup'`,
			);
		}
		const [sectionId, meta] = matches[0] as [number, { always_active: boolean }];
		if (meta.always_active) continue;
		locators.push({ ...locator('dd1067', TOOLS_REGISTER_SECTION, sectionId), id: id++ });
	}
	return locators;
}

/** One dd774 grant row. */
function grant(id: number, sectionTipo: string, tipo: string, value: number) {
	return { id, tipo, section_tipo: sectionTipo, value };
}

/** A user record: non-admin, non-developer, one profile, ONE project. */
function userColumns(name: string, profileId: number, projectId: number): Record<string, unknown> {
	return {
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: name }] },
		relation: {
			dd131: [locator('dd131', YES_NO_SECTION, YES)],
			dd244: [locator('dd244', YES_NO_SECTION, NO)],
			dd515: [locator('dd515', YES_NO_SECTION, NO)],
			dd1725: [locator('dd1725', PROFILES_SECTION, profileId)],
			[FILTER_MASTER_COMPONENT]: [locator(FILTER_MASTER_COMPONENT, PROJECTS_SECTION, projectId)],
		},
	};
}

/** A's project — the seeded row's shape (dd156 name), nothing else needed. */
function projectColumns(token: string): Record<string, unknown> {
	return {
		string: {
			[PROJECT_NAME_COMPONENT]: [{ id: 1, lang: 'lg-eng', value: `zzsb project of A ${token}` }],
		},
	};
}

/** One hierarchy1 record, servable by construction (the pruning fixture's shape). */
function hierarchyColumns(token: string): Record<string, unknown> {
	return {
		string: {
			hierarchy5: [{ id: 1, lang: 'lg-nolan', value: `zzsb scope-binding hierarchy ${token}` }],
			hierarchy53: [{ id: 1, lang: 'lg-nolan', value: SB_GRANTED_SECTION }],
		},
		relation: {
			hierarchy4: [locator('hierarchy4', YES_NO_SECTION, YES)],
			hierarchy125: [locator('hierarchy125', YES_NO_SECTION, YES)],
			hierarchy9: [locator('hierarchy9', 'hierarchy13', 2)],
			hierarchy45: [
				{
					id: 1,
					type: 'dd48',
					section_id: 1,
					section_tipo: SB_GRANTED_SECTION,
					from_component_tipo: 'hierarchy45',
				},
			],
		},
		number: { hierarchy48: [{ id: 1, value: 0 }] },
	};
}

/**
 * One dd655 editing preset owned by `ownerId` — the stored shape of the real
 * rows: `relation.dd654` = the owner's dd128 locator, `data.created_by_user_id`
 * = the creator (both arms of the assembler's owner predicate).
 */
function presetColumns(ownerId: number, creatorId = ownerId): Record<string, unknown> {
	return {
		string: { dd624: [{ id: 1, lang: 'lg-nolan', value: `zzsb preset of ${ownerId}` }] },
		relation: {
			[PRESET_OWNER_COMPONENT]: [locator(PRESET_OWNER_COMPONENT, USERS_SECTION, ownerId)],
		},
		data: {
			label: 'zzsb preset',
			section_id: null,
			section_tipo: TEMP_PRESET_SECTION,
			diffusion_info: null,
			created_by_user_id: creatorId,
		},
	};
}

function clearCaches(): void {
	clearPrincipalCache();
	clearUserProjectsCache();
	clearPermissionsCache();
	invalidateAllToolCaches();
}

/**
 * Mint ONE instance of the fixture: every record allocated through the engine's
 * counter door, so two instances on one database never share an id.
 * `extraGrantsOfA`: further [section, component] read-write grants on A's
 * profile — a gate's own scratch component (e.g. preset_ownership's hop, which
 * the SEC-1 root-step key refuses to a profile holding 0 on it).
 */
export async function installScopeBindingFixture(
	extraGrantsOfA: readonly (readonly [string, string])[] = [],
): Promise<ScopeBindingFixture> {
	await assertTestDatabase('installScopeBindingFixture');
	const tools = await grantedToolLocators();
	const token = `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
	const records: OwnedRecord[] = [];
	const insert = async (
		table: string,
		sectionTipo: string,
		columns: Record<string, unknown>,
	): Promise<number> => {
		const sectionId = await insertMatrixRecordWithCounter(table, sectionTipo, columns);
		records.push({ table, sectionTipo, sectionId });
		// A section_id is a positive address; 0 / negatives are the installed-root band.
		if (!Number.isInteger(sectionId) || sectionId < 1)
			throw new Error(
				`scope_binding_fixture: the allocator minted ${table}/${sectionTipo}/${sectionId} — not a positive section_id`,
			);
		return sectionId;
	};

	try {
		const profileA = await insert('matrix_profiles', PROFILES_SECTION, {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: `zzsb profile A ${token}` }] },
			relation: { dd1067: tools },
			misc: {
				dd774: [
					grant(1, SB_GRANTED_SECTION, SB_GRANTED_SECTION, 2),
					grant(2, SB_GRANTED_SECTION, SB_GRANTED_COMPONENT, 2),
					grant(3, SB_GRANTED_SECTION, SB_MEDIA_COMPONENT, 2),
					grant(4, SB_GRANTED_SECTION, SB_HOP_COMPONENT, 2),
					grant(5, SB_GRANTED_SECTION, SB_INPUT_COMPONENT, 2),
					...extraGrantsOfA.map(([section, tipo], index) => grant(100 + index, section, tipo, 2)),
				],
			},
		});
		const profileB = await insert('matrix_profiles', PROFILES_SECTION, {
			string: { dd237: [{ id: 1, lang: 'lg-eng', value: `zzsb profile B ${token}` }] },
			relation: { dd1067: tools },
			misc: {
				dd774: [
					grant(1, SB_HIERARCHY_SECTION, SB_HIERARCHY_SECTION, 2),
					grant(2, SB_GRANTED_SECTION, SB_GRANTED_SECTION, 2),
					grant(3, SB_GRANTED_SECTION, SB_GRANTED_COMPONENT, 2),
					grant(4, SB_GRANTED_SECTION, SB_MEDIA_COMPONENT, 2),
					grant(7, SB_GRANTED_SECTION, SB_HOP_COMPONENT, 2),
					grant(5, SB_DENIED_SECTION, SB_DENIED_SECTION, 1),
					grant(6, SB_DENIED_SECTION, SB_GRANTED_COMPONENT, 1),
					grant(8, SB_GRANTED_SECTION, SB_INPUT_COMPONENT, 2),
				],
			},
		});
		const projectOfA = await insert('matrix_projects', PROJECTS_SECTION, projectColumns(token));
		const userA = await insert(
			'matrix_users',
			USERS_SECTION,
			userColumns(`zzsb_a_${token}`, profileA, projectOfA),
		);
		const userB = await insert(
			'matrix_users',
			USERS_SECTION,
			userColumns(`zzsb_b_${token}`, profileB, config.features.defaultProject),
		);
		const hierarchyId = await insert(
			'matrix_hierarchy_main',
			SB_HIERARCHY_SECTION,
			hierarchyColumns(token),
		);
		const presetOfA = await insert('matrix_list', TEMP_PRESET_SECTION, presetColumns(userA));
		const presetOfB = await insert('matrix_list', TEMP_PRESET_SECTION, presetColumns(userB));
		const presetSplit = await insert(
			'matrix_list',
			TEMP_PRESET_SECTION,
			presetColumns(userA, userB),
		);
		clearCaches();
		return {
			userA,
			userB,
			profileA,
			profileB,
			hierarchyId,
			presetOfA,
			presetOfB,
			presetSplit,
			projectOfA,
			records,
		};
	} catch (error) {
		// Never leak a half-built instance: sweep what was written, then rethrow.
		await purge(records, { strict: false });
		clearCaches();
		throw error;
	}
}

/** Sweep every record THIS instance wrote plus its TM rows; strict on the matrix rows. */
export async function removeScopeBindingFixture(fixture: ScopeBindingFixture): Promise<void> {
	await assertTestDatabase('removeScopeBindingFixture');
	await purge(fixture.records, { strict: true });
	clearCaches();
}

async function purge(records: readonly OwnedRecord[], options: { strict: boolean }): Promise<void> {
	if (options.strict && records.length === 0)
		throw new Error('scope_binding_fixture: the handle names no records — nothing to sweep');
	const missing: string[] = [];
	// Reverse write order: the rows that point at others go first.
	for (const record of [...records].reverse()) {
		const removed = await deleteMatrixRecord(record.table, record.sectionTipo, record.sectionId);
		if (removed === 0) missing.push(`${record.table}/${record.sectionTipo}/${record.sectionId}`);
		await sql.unsafe(
			'DELETE FROM matrix_time_machine WHERE section_tipo = $1 AND section_id = $2',
			[record.sectionTipo, record.sectionId],
		);
	}
	if (options.strict && missing.length > 0) {
		throw new Error(
			`scope_binding_fixture: sweep deleted 0 rows for ${missing.join(', ')} — the filter is wrong, or the rows were never written`,
		);
	}
}
