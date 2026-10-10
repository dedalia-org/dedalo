/**
 * THE INSTALL SEED'S SOURCES — what the seed compiler (seed_build.ts) builds
 * the vendored install/db/dedalo_install.pgsql.gz from, and what its manifest
 * (seed_manifest.ts) fingerprints. Declarations only: no database, no I/O.
 *
 * Every byte of the seed traces to a file in this repository or to a constant
 * below — never to an installation's database (decision 2026-10-09: a seed
 * cloned from a working database shipped its 2022 data typo and broke every
 * fresh install). Changing what an install is born with is a diff to one of
 * these sources, then a recompile (`bun run seed:build`).
 */

import { join } from 'node:path';
import { projectRoot } from '../../config/env.ts';
import { CORE_ONTOLOGY_TLDS } from '../ontology/core_tlds.ts';
import { DEDALO_VERSION_MAJOR_MINOR } from '../update/version.ts';
import { SEED_SOURCES_DIR } from './paths.ts';

/** The schema source: DDL only; every later schema change is a migration on top. */
export const SEED_SCHEMA_PATH: string = join(SEED_SOURCES_DIR, 'schema.sql');
/** Languages thesaurus terms (matrix_langs, MATRIX_COPY_COLUMNS COPY text, gzip). */
export const SEED_LANGS_PATH: string = join(SEED_SOURCES_DIR, 'matrix_langs.copy.gz');
/**
 * Hierarchy registry records (matrix_hierarchy_main): the CORE hierarchies only
 * (`lg`, section_id 244), shipped inactive and activated by the install. Every
 * optional thesaurus's row is written at activation from its
 * install/import/hierarchy/hierarchy.json entry (WC-2026-10-10-hierarchy-json-manifest).
 */
export const SEED_REGISTRY_PATH: string = join(SEED_SOURCES_DIR, 'matrix_hierarchy_main.copy.gz');
/**
 * The parser's SCAFFOLD (dd_ontology rows, DD_ONTOLOGY_SCAFFOLD_COLUMNS): the
 * `ontology` TLD's own nodes and the model nodes. Deriving dd_ontology from the
 * packages reads component models and model names out of dd_ontology itself
 * (parser.ts getComponentItems / projectModel), so an empty database cannot
 * derive its first node. The compiler loads this, derives to a FIXPOINT and
 * requires every TLD in sync with no stale row — so the shipped dd_ontology is
 * the packages' projection, and the scaffold's own rows are all replaced.
 */
export const SEED_SCAFFOLD_PATH: string = join(SEED_SOURCES_DIR, 'dd_ontology_scaffold.copy.gz');

/** The scaffold's COPY columns (dd_ontology minus its id). */
export const DD_ONTOLOGY_SCAFFOLD_COLUMNS: readonly string[] = Object.freeze([
	'tipo',
	'parent',
	'term',
	'model',
	'order_number',
	'relations',
	'tld',
	'properties',
	'model_tipo',
	'is_model',
	'is_translatable',
	'is_main',
	'propiedades',
]);

/** The ontology release the seed ships: the packages ontology clients download. */
export const ONTOLOGY_RELEASE_DIR: string = join(
	projectRoot,
	'install/import/ontology',
	DEDALO_VERSION_MAJOR_MINOR,
);
/** The migrations applied on top of schema.sql (the boot runner's own files). */
export const SEED_MIGRATIONS_DIR: string = join(projectRoot, 'install/db/migrations');

/**
 * The TLDs whose ontology ships: the CORE, exactly (core_tlds.ts is the ONE
 * home of that list — read, never restated). The seed is CORE-ONLY: no domain
 * ontology (`oh` included — it is the installer's DEFAULT domain answer,
 * installed from the vendored install/import/ontology/<release>/oh.copy.gz by
 * ontology_install.ts after the restore) and no `test` TLD (the suite's, which
 * test_tld_materialize.ts provisions — registry row included — from its JSON).
 */
export const SEED_ONTOLOGY_TLDS: readonly string[] = CORE_ONTOLOGY_TLDS;

/**
 * The tables that ship ROWS, and from where. Every other table in the schema
 * ships EMPTY, its sequences at 1. Gate: the content contract.
 */
export const SEED_SHIPPED_TABLES: Readonly<Record<string, string>> = Object.freeze({
	dd_ontology: 'derived from the ontology packages (setRecordsInDdOntology)',
	matrix_ontology: 'the ontology packages',
	matrix_ontology_main: 'the release manifest active_ontologies (syncMainSectionFromDefinition)',
	matrix_dd: 'the matrix_dd package (private lists)',
	matrix_langs: 'install/db/seed/matrix_langs.copy.gz',
	matrix_hierarchy_main: 'install/db/seed/matrix_hierarchy_main.copy.gz (the core lg row only)',
	matrix_users: 'SEED_RECORDS',
	matrix_projects: 'SEED_RECORDS',
	matrix_profiles: 'SEED_RECORDS',
	matrix_updates: 'generated: the current data version',
});

/** Its presence in a database is what makes that database droppable by this compiler. */
export const SEED_BUILD_MARKER_TABLE = 'dedalo_seed_build_marker';

/** Scratch database names: `<prefix><pid>`, swept when marked and orphaned. */
export const SEED_SCRATCH_PREFIXES: readonly string[] = Object.freeze([
	'dedalo_seed_build_',
	'dedalo_seed_verify_',
]);

/** The throwaway root password the verify install sets (and checks) — never shipped. */
export const SEED_VERIFY_ROOT_PASSWORD = 'Verify-Seed-Kestrel-Harbor-47';

/** Root's audit locators, shared by every canonical record. */
const BY_ROOT = {
	dd197: [
		{ id: 1, type: 'dd151', section_id: '-1', section_tipo: 'dd128', from_component_tipo: 'dd197' },
	],
	dd200: [
		{ id: 1, type: 'dd151', section_id: '-1', section_tipo: 'dd128', from_component_tipo: 'dd200' },
	],
};

const dateValue = (start: Record<string, number>) => [{ id: 1, start }];

/** One canonical seed record: the jsonb columns it carries (absent ⇒ NULL). */
export interface SeedRecord {
	table: string;
	section_id: number;
	section_tipo: string;
	data: unknown;
	relation?: unknown;
	string?: unknown;
	date?: unknown;
	meta?: unknown;
}

/**
 * The canonical records every install is born with — byte-for-byte the rows
 * the vendored seed has always shipped (PHP installer_data_seeder): root
 * (dd128/-1, NO password: installer root_pw.ts sets it), the General project
 * (dd153/1) and the Admin/User profiles (dd234/1,2). No test3 row: the
 * playground is the SUITE's (scripts/test_db_setup.ts), never an install's.
 */
export const SEED_RECORDS: readonly SeedRecord[] = Object.freeze([
	{
		table: 'matrix_users',
		section_id: -1,
		section_tipo: 'dd128',
		data: {
			label: 'Usuarios',
			created_date: '2022-09-30 13:48:31',
			section_tipo: 'dd128',
			modified_date: '2022-09-30 13:48:31',
			created_by_user_id: -1,
			modified_by_user_id: -1,
		},
		relation: {
			dd131: [
				{
					id: 1,
					type: 'dd151',
					section_id: '1',
					section_tipo: 'dd64',
					from_component_tipo: 'dd131',
				},
			],
			...BY_ROOT,
			dd244: [
				{
					id: 1,
					type: 'dd151',
					section_id: '2',
					section_tipo: 'dd64',
					from_component_tipo: 'dd244',
				},
			],
			dd1725: [
				{
					id: 1,
					type: 'dd151',
					section_id: '2',
					section_tipo: 'dd234',
					from_component_tipo: 'dd1725',
				},
			],
		},
		string: { dd132: [{ id: 1, lang: 'lg-nolan', value: 'root' }], dd133: [] },
		date: {
			dd199: dateValue({
				day: 30,
				hour: 12,
				time: 64772914091,
				year: 2022,
				month: 9,
				minute: 8,
				second: 11,
			}),
			dd201: dateValue({
				day: 30,
				hour: 12,
				time: 64772914091,
				year: 2022,
				month: 9,
				minute: 8,
				second: 11,
			}),
		},
		meta: {
			dd131: [{ count: 1 }],
			dd132: [{ count: 1 }],
			dd197: [{ count: 1 }],
			dd199: [{ count: 1 }],
			dd200: [{ count: 1 }],
			dd201: [{ count: 1 }],
			dd244: [{ count: 1 }],
			dd1725: [{ count: 1 }],
		},
	},
	{
		table: 'matrix_projects',
		section_id: 1,
		section_tipo: 'dd153',
		data: {
			label: 'Proyectos',
			created_date: '2010-02-15 00:00:00',
			section_tipo: 'dd153',
			modified_date: '2018-12-10 16:12:02',
			diffusion_info: null,
			created_by_user_id: -1,
			modified_by_user_id: -1,
		},
		relation: BY_ROOT,
		string: {
			dd155: [{ id: 1, lang: 'lg-nolan', value: '001' }],
			dd156: [{ id: 1, lang: 'lg-eng', value: 'General project' }],
		},
		date: {
			dd199: dateValue({
				day: 15,
				hour: 0,
				time: 64606896000,
				year: 2010,
				month: 2,
				minute: 0,
				second: 0,
			}),
			dd201: dateValue({
				day: 10,
				hour: 16,
				time: 64890432722,
				year: 2018,
				month: 12,
				minute: 12,
				second: 2,
			}),
		},
		meta: {
			dd155: [{ count: 1 }],
			dd156: [{ count: 1 }],
			dd197: [{ count: 1 }],
			dd199: [{ count: 1 }],
			dd200: [{ count: 1 }],
			dd201: [{ count: 1 }],
		},
	},
	...(
		[
			[1, 'Admin', '<p>Admin general</p>', 64803010979, 22, 59],
			[2, 'User', '<p>Generic user</p>', 64803011216, 26, 56],
		] as const
	).map(([sectionId, name, description, time, minute, second]) => ({
		table: 'matrix_profiles',
		section_id: sectionId,
		section_tipo: 'dd234',
		data: {
			label: 'Profiles',
			created_date: '2016-03-21 20:26:56',
			section_tipo: 'dd234',
			modified_date: '2017-05-08 14:27:58',
			diffusion_info: null,
			created_by_user_id: -1,
			modified_by_user_id: -1,
		},
		relation: BY_ROOT,
		string: {
			dd237: [{ id: 1, lang: 'lg-eng', value: name }],
			dd238: [{ id: 1, lang: 'lg-eng', value: description }],
		},
		date: {
			dd199: dateValue({ day: 21, hour: 20, time, year: 2016, month: 3, minute, second }),
			dd201: dateValue({
				day: 8,
				hour: 14,
				time: 64839364078,
				year: 2017,
				month: 5,
				minute: 27,
				second: 58,
			}),
		},
		meta: {
			dd197: [{ count: 1 }],
			dd199: [{ count: 1 }],
			dd200: [{ count: 1 }],
			dd201: [{ count: 1 }],
			dd237: [{ count: 1 }],
			dd238: [{ count: 1 }],
		},
	})),
]);
