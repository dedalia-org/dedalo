<?php declare(strict_types=1);
/**
* UPDATES CONTROL
* Registry of all version-to-version migration steps for the Dédalo data layer.
*
* This file is included (not required_once) by update::get_updates() each time it
* runs, so it must remain side-effect-free beyond populating $updates.
*
* Each migration is keyed by an integer formed by concatenating version digits
* (e.g. 700 = v7.0.0, 701 = v7.0.1). The key is unique and controls iteration
* order inside update::get_updates().
*
* Every update entry is a stdClass with this shape:
*
* {
* 	# UPDATE TO
*	 	version_major		: int
*	 	version_medium		: int
*	 	version_minor		: int
*
*	# MINIMUM UPDATE FROM
*	 	update_from_major	: int
*	 	update_from_medium	: int
*	 	update_from_minor	: int
*
* 	# UPDATE HAS A DATA PROCESSES
* 	 	update_data 		: bool
*
*	# DATA ALERT
* 	 	alert_update 		: array
*
* 	# DATA PROCESSES
* 	 	SQL_update			: array
* 	 	run_scripts			: array
* 	 	components_update	: array
* }
*
* Execution pipeline (orchestrated by update::update_version()):
*   1. run_pre_scripts  — PHP class methods to run before any SQL (e.g. schema pre-checks)
*   2. SQL_update       — raw PostgreSQL statements executed in sequence
*   3. components_update — iterate every section record and update component data format
*   4. run_scripts      — PHP class methods (data migrations, index rebuilds, cleanup)
*
* Script objects (run_pre_scripts / run_scripts entries) share this shape:
*   {
*     info          : string  - human-readable description for the update log
*     script_class  : string  - fully-qualified PHP class (must be require_once'd above)
*     script_method : string  - static method name on that class
*     stop_on_error : bool    - true = abort the whole update pipeline on failure
*     script_vars   : array   - positional arguments forwarded to the method
*   }
*
* @package Dédalo
* @subpackage Core
*/
global $updates;
$updates = new stdClass();



$v=700; #####################################################################################
$updates->$v = new stdClass();

	// UPDATE TO
	$updates->$v->version_major			= 7;
	$updates->$v->version_medium		= 0;
	$updates->$v->version_minor			= 0;

	// MINIMUM UPDATE FROM
	$updates->$v->update_from_major		= 6;
	$updates->$v->update_from_medium	= 9;
	$updates->$v->update_from_minor		= 1;

	// MINIMUM, not exact: any v6 data version at or after the triple above can be
	// migrated (6.9.2, 6.9.3, … change nothing this migration reads). But
	// update::pre_update_version() / update_version() select the descriptor by an
	// EXACT match on update_from, so the close_v6_prepare_v7 runner exports the DB's
	// actual version in PREPARE_V7_UPDATE_FROM after its version gate verified
	// "minimum <= current < 7.0.0", and the descriptor aligns itself here.
	// Unset (any normal boot) → the literal minimum above, unchanged behaviour.
	// The override can only RAISE update_from: a too-old DB can never be forced through.
		$prepare_v7_update_from = getenv('PREPARE_V7_UPDATE_FROM');
		if (is_string($prepare_v7_update_from)
			&& preg_match('/^(\d+)\.(\d+)\.(\d+)$/', $prepare_v7_update_from, $prepare_v7_from_parts)===1) {

			$prepare_v7_min = $updates->$v->update_from_major
				. '.' . $updates->$v->update_from_medium
				. '.' . $updates->$v->update_from_minor;

			if (version_compare($prepare_v7_update_from, $prepare_v7_min, '>=')
				&& (int)$prepare_v7_from_parts[1] < $updates->$v->version_major) {

				$updates->$v->update_from_major		= (int)$prepare_v7_from_parts[1];
				$updates->$v->update_from_medium	= (int)$prepare_v7_from_parts[2];
				$updates->$v->update_from_minor		= (int)$prepare_v7_from_parts[3];
			}
			unset($prepare_v7_min, $prepare_v7_from_parts);
		}
		unset($prepare_v7_update_from);

	// require a clean installation
	// it only could be 'clean' | null. Incremental option has not sense to be forced.
		$updates->$v->force_update_mode = 'clean';

	// Load class with update methods
		require_once dirname(dirname(__FILE__)) .'/upgrade/class.v6_to_v7.php';

	// Pre update, changing jer_dd data in PostgreSQL with new format and set `dd_ontology` table.
	// (!) Must run before any SQL_update: the pre_update step converts the ontology source
	//     table so that DEDALO_* constants referenced in SQL_update are already resolvable.
		$updates->$v->run_pre_scripts[] = (object)[
			'info'			=> 'Set a new table `dd_ontology` with old `jer_dd` in PostgreSQL with new v7 schema',
			'script_class'	=> 'v6_to_v7',
			'script_method'	=> 'pre_update',
			'stop_on_error'	=> true,
			'script_vars'	=> [
			] // Note that only ONE argument encoded is sent
		];

	// SQL UPDATE ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////

		// Rename matrix_activity column date to timestamp.
		// The date column will be used to store the component_date data.
		// (!) The rename is guarded by an IF EXISTS check so the statement is idempotent
		//     and safe to re-run on installations that already renamed the column.
		$updates->$v->SQL_update[] = PHP_EOL.sanitize_query('
			DO $$
			BEGIN
				IF EXISTS (
					SELECT 1
					FROM information_schema.columns
					WHERE table_name = \'matrix_activity\'
					AND column_name = \'date\'
					AND data_type != \'jsonb\'
				) THEN
					EXECUTE \'ALTER TABLE matrix_activity RENAME COLUMN date TO "timestamp"\';
					EXECUTE \'COMMENT ON COLUMN matrix_activity."timestamp" IS \'\'Activity timestamp (previously date)\'\'\';
				END IF;
			END $$;
		');

		// Rename matrix_notifications column datos to data
		// Normalises the Spanish column name ('datos') to the v7 English convention ('data').
		$updates->$v->SQL_update[] = PHP_EOL . sanitize_query('
			DO $$
			BEGIN
				IF EXISTS (
					SELECT 1
					FROM information_schema.columns
					WHERE table_name = \'matrix_notifications\'
					AND column_name = \'datos\'
				) THEN
					EXECUTE \'ALTER TABLE matrix_notifications RENAME COLUMN datos TO data\';
				END IF;
			END $$;
		');

		// DATA INSIDE DATABASE UPDATES
		// clean_section_and_component_dato. Update 'datos' to section_data
		// $ar_tables holds every matrix table that stores component data in v7's
		// typed-column layout (data, relation, string, date, iri, geo, number, media,
		// misc, relation_search, meta). This list is reused later by run_scripts that
		// process or clean legacy columns.
		$ar_tables = [
			'matrix',
			'matrix_activities',
			'matrix_activity',
			'matrix_dataframe',
			'matrix_dd',
			'matrix_hierarchy',
			'matrix_hierarchy_main',
			'matrix_indexations',
			'matrix_langs',
			'matrix_layout',
			'matrix_layout_dd',
			'matrix_list',
			'matrix_nexus',
			'matrix_nexus_main',
			'matrix_notes',
			'matrix_ontology',
			'matrix_ontology_main',
			'matrix_profiles',
			'matrix_projects',
			'matrix_stats',
			'matrix_test',
			'matrix_tools',
			'matrix_users'
		];

		// SPLIT OF THE LEGACY 'datos' CLEANUP (two drop steps, see both below).
		// $ar_tables_auth is everything the v6 UI needs to AUTHENTICATE and render the
		// maintenance dashboard: the user record, the profile its permissions resolve
		// through, and the activity log the login path writes an audit row into
		// (logger_backend_activity -> matrix_activity). Their 'datos' survives to the
		// very last step so the operator can log back in and watch a multi-hour run.
		// $ar_tables_bulk is everything else — every table that actually holds records.
		// Their 'datos' is dropped at the ORIGINAL mid-pipeline position, on purpose:
		// once reformat_matrix_data has frozen the typed columns, a v6 save writes only
		// 'datos' and would be silently destroyed by the final drop. Dropping the column
		// early makes such a save fail LOUDLY with a SQL error instead of losing data.
		// v6 is monitoring-only during the migration; this is what enforces it.
		$ar_tables_auth = [
			'matrix_users',
			'matrix_profiles',
			'matrix_activity'
		];
		$ar_tables_bulk = array_values(array_diff($ar_tables, $ar_tables_auth));

		// Create the new table structure, with new columns for data type.
		// Each ADD COLUMN … IF NOT EXISTS is idempotent: re-running the update
		// on a partially-migrated database will not duplicate columns.
		// The COMMENT ON statements are collected separately so they can be sent as
		// a single batch after all ALTER TABLE statements complete.
		$columns_sentences = [];
		$comments_sentences = [];
		foreach ($ar_tables as $current_table) {
			$columns_sentences [] = '
				ALTER TABLE "'.$current_table.'"
					ADD COLUMN IF NOT EXISTS "data" jsonb NULL,
					ADD COLUMN IF NOT EXISTS "relation" jsonb NULL,
					ADD COLUMN IF NOT EXISTS "string" jsonb NULL,
					ADD COLUMN IF NOT EXISTS "date" jsonb NULL,
					ADD COLUMN IF NOT EXISTS "iri" jsonb NULL,
					ADD COLUMN IF NOT EXISTS "geo" jsonb NULL,
					ADD COLUMN IF NOT EXISTS "number" jsonb NULL,
					ADD COLUMN IF NOT EXISTS "media" jsonb NULL,
					ADD COLUMN IF NOT EXISTS "misc" jsonb NULL,
					ADD COLUMN IF NOT EXISTS "relation_search" jsonb NULL,
					ADD COLUMN IF NOT EXISTS "meta" jsonb NULL;
			';
			$comments_sentences[] = "
				COMMENT ON COLUMN " . $current_table . ".id IS 'Unique table identifier';
				COMMENT ON COLUMN " . $current_table . ".section_id IS 'Section unique identifier';
				COMMENT ON COLUMN " . $current_table . ".section_tipo IS 'Ontology section identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)';
				COMMENT ON COLUMN " . $current_table . ".data IS 'Section data';
				COMMENT ON COLUMN " . $current_table . ".relation IS 'Component data with relation values: " . DEDALO_RELATION_TYPE_LINK . " | " . DEDALO_RELATION_TYPE_CHILDREN_TIPO . " | " . DEDALO_RELATION_TYPE_PARENT_TIPO . " | " . DEDALO_RELATION_TYPE_INDEX_TIPO . " | " . DEDALO_RELATION_TYPE_MODEL_TIPO . " | " . DEDALO_RELATION_TYPE_FILTER . "';
				COMMENT ON COLUMN " . $current_table . ".string IS 'Component data with string values: " . DEDALO_VALUE_TYPE_STRING . "';
				COMMENT ON COLUMN " . $current_table . ".date IS 'Component data with date values: " . DEDALO_VALUE_TYPE_DATE . "';
				COMMENT ON COLUMN " . $current_table . ".iri IS 'Component data with IRI values: " . DEDALO_VALUE_TYPE_IRI . "';
				COMMENT ON COLUMN " . $current_table . ".geo IS 'Component data with geolocation values: " . DEDALO_VALUE_TYPE_GEO . "';
				COMMENT ON COLUMN " . $current_table . ".number IS 'Component data with number values: " . DEDALO_VALUE_TYPE_NUMBER . "';
				COMMENT ON COLUMN " . $current_table . ".media IS 'Component data with media values: " . DEDALO_VALUE_TYPE_MEDIA . "';
				COMMENT ON COLUMN " . $current_table . ".misc IS 'Other component data with miscellaneous values: " . DEDALO_VALUE_TYPE_MISC . "';
				COMMENT ON COLUMN " . $current_table . ".relation_search IS 'Complementary relationships as parents, used to search for all children of the parent being searched for.';
				COMMENT ON COLUMN " . $current_table . ".meta IS 'Component metadata, used as counters for components and other value identifiers.';
			";
		}
		$updates->$v->SQL_update[] = PHP_EOL . sanitize_query(implode(PHP_EOL, $columns_sentences));
		$updates->$v->SQL_update[] = PHP_EOL . sanitize_query(implode(PHP_EOL, $comments_sentences));
		$updates->$v->SQL_update[] = PHP_EOL . sanitize_query('ANALYZE ' . implode(', ', array_map(fn($t) => '"' . $t . '"', $ar_tables)) . ';');

		// Rename the "datos" column "data" in the other tables.
		// $other_tables covers tables whose schema differs from the main typed-column
		// layout above; they store a single general-purpose JSON column renamed here.
		$columns_sentences = [];
		$comments_sentences = [];
		// other kind of tables
		$other_tables = [
			'matrix_updates'
		];
		foreach ($other_tables as $current_table) {
			$columns_sentences [] = "
			DO $$
			BEGIN
				IF EXISTS (
					SELECT 1
					FROM information_schema.columns
					WHERE table_name = '$current_table'
					AND column_name = 'datos'
				) THEN
					ALTER TABLE \"$current_table\" RENAME COLUMN datos TO data;
				END IF;
			END $$;
			";
			$comments_sentences[] = "
				COMMENT ON COLUMN " . $current_table . ".data IS 'Table data as a general JSON data';
			";
		}
		$updates->$v->SQL_update[] = PHP_EOL . sanitize_query(implode(PHP_EOL, $columns_sentences));
		$updates->$v->SQL_update[] = PHP_EOL . sanitize_query(implode(PHP_EOL, $comments_sentences));
		$updates->$v->SQL_update[] = PHP_EOL . sanitize_query('ANALYZE ' . implode(', ', array_map(fn($t) => '"' . $t . '"', $other_tables)) . ';');

		// Create new temporary table with key -> value
		// Use to storage temporary sections (sections without section_id or section_id=0)
		// key string as section_tipo_user_id or any other string combination as section_tipo_section_id_user_id
		// UNLOGGED: data is not written to the WAL, so it survives a clean shutdown
		// but is lost on a crash. Acceptable for transient draft sections.
		$updates->$v->SQL_update[] = PHP_EOL.sanitize_query('
			CREATE UNLOGGED TABLE IF NOT EXISTS temp (
				key text PRIMARY KEY,
				value jsonb NULL
			);
		');

		// Set the matrix_notifications as "UNLOGGED" to optimize write operations
		// Notification rows are ephemeral; crash-safety is not required, and removing
		// WAL overhead significantly reduces write latency on busy installations.
		$updates->$v->SQL_update[] = PHP_EOL.sanitize_query('
			ALTER TABLE matrix_notifications SET UNLOGGED;
		');

		// create index for matrix_langs hierarchy41 value (lang code as 'eng')
		// The language code is buried inside the string column at key 'hierarchy41', first
		// element, 'value' property. A functional index on this JSON path makes language
		// look-ups by code (e.g. 'eng', 'spa') fast without a full table scan.
		$updates->$v->SQL_update[] = PHP_EOL.sanitize_query('
			DROP INDEX IF EXISTS "idx_matrix_langs_hierarchy41_value";
			CREATE INDEX IF NOT EXISTS idx_matrix_langs_hierarchy41_value ON "matrix_langs" (
				(string->\'hierarchy41\'->0->>\'value\')
			);
			ANALYZE matrix_langs;
		');

		// create index for matrix_time_machine. The default search is performed using the following: section_id, section_tipo, tipo, lang, timestamp DESC.
		// Composite index matches the WHERE + ORDER BY clause used by the time-machine
		// diff viewer, keeping point-in-time lookups O(log n) even on large audit tables.
		$updates->$v->SQL_update[] = PHP_EOL.sanitize_query('
			DROP INDEX IF EXISTS "idx_matrix_time_machine_search_default";
			CREATE INDEX IF NOT EXISTS idx_matrix_time_machine_search_default ON "matrix_time_machine" (
				section_id, section_tipo, tipo, lang, timestamp DESC
			);
			ANALYZE matrix_time_machine;
		');

		// matrix_counter: replace implicit index with an explicit UNIQUE constraint on 'tipo'.
		// A UNIQUE constraint provides the same index performance while also enforcing
		// data integrity. The old btree index (matrix_counter_tipo_idx) is dropped first
		// to avoid duplicate coverage. The BEGIN/COMMIT makes both DDL steps atomic.
		$updates->$v->SQL_update[] = PHP_EOL.sanitize_query('
			DROP INDEX IF EXISTS "matrix_counter_tipo_idx";

			BEGIN;

			-- Drop the constraint if it exists (safe operation in recent PostgreSQL versions)
			ALTER TABLE matrix_counter
			DROP CONSTRAINT IF EXISTS matrix_counter_tipo_key;

			-- Add the constraint
			ALTER TABLE matrix_counter
			ADD CONSTRAINT matrix_counter_tipo_key UNIQUE (tipo);

			COMMIT;
		');

		// matrix_counter_dd: same UNIQUE-constraint promotion as matrix_counter above,
		// applied to the companion Dédalo-internal counter table.
		$updates->$v->SQL_update[] = PHP_EOL.sanitize_query('
			DROP INDEX IF EXISTS "matrix_counter_dd_tipo_idx";

			BEGIN;

			-- Drop the constraint if it exists (safe operation in recent PostgreSQL versions)
			ALTER TABLE matrix_counter_dd
			DROP CONSTRAINT IF EXISTS matrix_counter_dd_tipo_key;

			-- Add the constraint
			ALTER TABLE matrix_counter_dd
			ADD CONSTRAINT matrix_counter_dd_tipo_key UNIQUE (tipo);

			COMMIT;
		');

		// matrix_counter: rename 'dato' column to 'value' and rebuild the table.
		// The v6 schema used the Spanish 'dato'; v7 standardises on 'value'.
		// Because PostgreSQL cannot alter a column that has data dependencies (primary
		// key, check constraints), the safest migration path is:
		//   rename original → temp → create clean table → copy data → drop temp.
		// The IF EXISTS guard makes the block idempotent for already-migrated databases.
		$updates->$v->SQL_update[] = PHP_EOL.sanitize_query('
			DO $$
			BEGIN
				IF EXISTS (
					SELECT 1
					FROM information_schema.columns
					WHERE table_name = \'matrix_counter\'
					AND column_name = \'dato\'
				) THEN
					-- Rename the Original Table
					ALTER TABLE matrix_counter RENAME TO temp_matrix_counter;
					-- Create a New Table
					CREATE TABLE matrix_counter (
						"tipo" character varying(128) NOT NULL,
						"value" integer,
						"ref" text,
						CONSTRAINT matrix_counter_tipo_pkey PRIMARY KEY ("tipo")
					);
					-- Copy Data from the temporary table to the new table
					INSERT INTO matrix_counter (tipo, value, ref)
					SELECT tipo, dato, ref
					FROM temp_matrix_counter;
					-- Drop the Temporary Table
					DROP TABLE temp_matrix_counter;
					ANALYZE matrix_counter;
				END IF;
			END $$;
		');

		// matrix_counter_dd: same rename-rebuild pattern as matrix_counter above,
		// applied to the Dédalo-ontology counter table.
		$updates->$v->SQL_update[] = PHP_EOL.sanitize_query('
			DO $$
			BEGIN
				IF EXISTS (
					SELECT 1
					FROM information_schema.columns
					WHERE table_name = \'matrix_counter_dd\'
					AND column_name = \'dato\'
				) THEN
					-- Rename the Original Table
					ALTER TABLE matrix_counter_dd RENAME TO temp_matrix_counter_dd;
					-- Create a New Table
					CREATE TABLE matrix_counter_dd (
						"tipo" character varying(128) NOT NULL,
						"value" integer,
						"ref" text,
						CONSTRAINT matrix_counter_dd_tipo_pkey PRIMARY KEY ("tipo")
					);
					-- Copy Data from the temporary table to the new table
					INSERT INTO matrix_counter_dd (tipo, value, ref)
					SELECT tipo, dato, ref
					FROM temp_matrix_counter_dd;
					-- Drop the Temporary Table
					DROP TABLE temp_matrix_counter_dd;
					ANALYZE matrix_counter_dd;
				END IF;
			END $$;
		');

	// SCRIPTS ///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

		// Only checks data without save (DEBUG ONLY)
			// $updates->$v->run_scripts[] = (object)[
			// 	'info'			=> 'CHECK all data in PostgreSQL to use v7 new format (ONLY CHECKS DATA WITHOUT SAVE. STOPS THE UPDATE IF FOUND ERRORS)',
			// 	'script_class'	=> 'v6_to_v7',
			// 	'script_method'	=> 'reformat_matrix_data',
			// 	'stop_on_error'	=> true,
			// 	'script_vars'	=> [
			// 		$ar_tables,
			// 		false, // save option. On false, only data review is made. Not save
			// 		'matrix_processor' // process type
			// 	] // Note that only ONE argument encoded is sent
			// ];

		// Ontology machine names (ontology43 / ontology44), owner decisions 2026-11-03 / 2026-11-04.
		// Writes v6-SHAPED values on the v6 ontology records (and re-keys their ontology5 lg-spa
		// Time Machine rows), so it MUST run after pre_update (classification) and BEFORE
		// reformat_matrix_data, which then converts them like any other component.
		// stop_on_error=true: only a database failure fails it (an ambiguous name is a finding,
		// reported by the preflight), and nothing has been converted yet when it stops.
		// Idempotent: a re-run finds every value present.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'Set the ontology machine names (ontology43) and their use flag (ontology44) on the v6 ontology records',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'migrate_ontology_machine_names',
				'stop_on_error'	=> true,
				'script_vars'	=> [
					['matrix_ontology'],
					true // save option. On false, only data review is made. Not save
				] // Note that only ONE argument encoded is sent
			];

		// Updates all data in PostgreSQL with the new v7 format
		// stop_on_error=false: individual row failures are logged but do not
		// halt the migration; the update pipeline continues to subsequent steps.
		// The save argument (true) causes v6_to_v7::reformat_matrix_data() to
		// persist every reformatted row immediately.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'UPDATE all data in PostgreSQL with new v7 format (SAVE DATA IGNORING FOUND ERRORS)',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'reformat_matrix_data',
				'stop_on_error'	=> false,
				'script_vars'	=> [
					$ar_tables,
					true // save option. On false, only data review is made. Not save
				] // Note that only ONE argument encoded is sent
			];

		// Delete all indexes in PostgreSQL
		// Removes v6-era indexes whose names, columns, or expressions no longer
		// match the v7 schema. Indexes are recreated in the recreate_db_assets step.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'Delete all INDEXES and functions in PostgreSQL. Cleaning unused indexes',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'delete_v6_db_indexes',
				'stop_on_error'	=> false,
				'script_vars'	=> [
				] // Note that only ONE argument encoded is sent
			];

		// Rename the constraints in PostgreSQL
		// Unifies constraint names to the v7 naming convention so that subsequent
		// DROP CONSTRAINT IF EXISTS statements are predictable across all installations.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'Rename all CONSTRAINTS in PostgreSQL. Unification of the constraints',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'rename_constraint',
				'stop_on_error'	=> false,
				'script_vars'	=> [
				] // Note that only ONE argument encoded is sent
			];

		// TM : Recreate the tm table in PostgreSQL. Extends the `matrix_time_machine` table with new columns required by the v7 schema.
		// (!) Run before Recreate all assets in PostgreSQL to prevent index creation of non existent columns
		// stop_on_error=true: the time-machine table is critical; if it cannot be
		// recreated the subsequent fill_new_columns_in_tm step would write to missing
		// columns and corrupt the audit trail.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'Recreate the Time machine table (matrix_time_machine) in PostgreSQL. Add "user_id", "bulk_process" and "data" columns.',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'recreate_tm_table',
				'stop_on_error'	=> true,
				'script_vars'	=> [
				] // Note that only ONE argument encoded is sent
			];

		// Recreate the database assets in PostgreSQL (functions, indexes, constraints, etc.)
		// Re-applies all v7 pg_functions, GIN/btree indexes, and FK constraints
		// after the schema has been restructured. Must run after delete_v6_db_indexes
		// and recreate_tm_table so all target columns exist.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'Recreate all assets in PostgreSQL (EXTENSIONS, CONSTRAINTS, FUNCTIONS, INDEXES)',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'recreate_db_assets',
				'stop_on_error'	=> false,
				'script_vars'	=> [
				] // Note that only ONE argument encoded is sent
			];

		// TM : Remove the unused sections in tm table in PostgreSQL. Only deleted sections are stored and contains recoverable data.
		// Prunes matrix_time_machine rows that belong to sections which were created
		// (not deleted) — those rows are not needed for recovery and inflate the table.
		// stop_on_error=true: if the pruning query fails the remaining TM steps would
		// operate on an oversized dataset and risk timeout or data loss.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'Remove the unused sections in Time machine table (matrix_time_machine) in PostgreSQL. Only deleted sections are stored and contains recoverable data',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'remove_tm_created_sections',
				'stop_on_error'	=> true,
				'script_vars'	=> [
				] // Note that only ONE argument encoded is sent
			];

		// TM : Fill the new  columns `user_id`, `bulk_process` and `data` with its previous column data.
		// Backfills the three new typed columns from the legacy monolithic 'datos'
		// JSON blob. stop_on_error=true: missing data in user_id/bulk_process/data
		// would silently break the time-machine diff UI.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'Fill the new Time machine table (matrix_time_machine) columns "user_id", "bulk_process" and "data" with its previous column data. ',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'fill_new_columns_in_tm',
				'stop_on_error'	=> true,
				'script_vars'	=> [
				] // Note that only ONE argument encoded is sent
			];

		// TM : Delete old 'section_id_key', 'state', 'userID', 'dato' tm columns in PostgreSQL.
		// Final cleanup of v6-only columns now superseded by the new typed layout.
		// stop_on_error=false: column removal is best-effort; missing columns on a
		// partially-migrated instance will produce a harmless error and the pipeline
		// continues.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'Delete Time machine table (matrix_time_machine) old columns "section_id_key" and "state" in PostgreSQL.',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'delete_tm_columns',
				'stop_on_error'	=> false,
				'script_vars'	=> [
				] // Note that only ONE argument encoded is sent
			];

		// TM : Rename column "bulk_process_temp" to "bulk_process_id" in PostgreSQL.
		// The column was created as 'bulk_process_temp' during fill_new_columns_in_tm
		// to avoid name conflicts with the existing column; it is promoted to its final
		// name here once the old column has been dropped.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'Rename Time machine column "bulk_process_temp" to "bulk_process_id" (matrix_time_machine) in PostgreSQL.',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'rename_tm_column_bulk_process',
				'stop_on_error'	=> false,
				'script_vars'	=> [
				] // Note that only ONE argument encoded is sent
			];

		// TM : Update all Time machine data in PostgreSQL with new v7 format
		// Reformats the content of the 'data' column in matrix_time_machine to
		// the v7 component-datum shape (typed-column per value type), mirroring what
		// reformat_matrix_data did for the main matrix tables.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'UPDATE all data Time machine in PostgreSQL with new v7 format (SAVE DATA IGNORING FOUND ERRORS)',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'reformat_matrix_time_machine_data',
				'stop_on_error'	=> false,
				'script_vars'	=> [
					['matrix_time_machine'],
					true // save option. On false, only data review is made. Not save
				] // Note that only ONE argument encoded is sent
			];

		// DIFFUSION_ACTIVITY : Create matrix_activity_diffusion table
		// Creates the table that tracks which records have been diffused (published)
		// and records the last diffusion timestamp per locator. Required by the v7
		// diffusion pipeline before any publish operation can run.
		// stop_on_error=true: the diffusion subsystem is unusable without this table.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'Create MATRIX_ACTIVITY_DIFFUSION table.',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'create_matrix_activity_diffusion_table',
				'stop_on_error'	=> true,
				'script_vars'	=> [
				] // Note that only ONE argument encoded is sent
			];

		// Cleanup [1/2]: drop legacy 'datos' from the RECORD tables, at the original
		// mid-pipeline position. Everything from here on reads the v7 typed columns, so
		// nothing below needs 'datos' — and keeping it on the record tables through the
		// hours-long tail would give a still-logged-in v6 user a way to "save" a record
		// into a column that the final drop then deletes, with no error and no trace.
		// The auth tables are deliberately excluded and dropped last (see [2/2]).
		// stop_on_error=false: the IF EXISTS guard in the method makes a re-run a no-op.
			$updates->$v->run_scripts[] = (object)[
				'info'			=> 'DROP legacy "datos" column in the record matrix tables (keeps the auth tables until the end)',
				'script_class'	=> 'v6_to_v7',
				'script_method'	=> 'drop_legacy_datos_column',
				'stop_on_error'	=> false,
				'script_vars'	=> [
					$ar_tables_bulk
				] // Note that only ONE argument encoded is sent
			];

	// Load class with update methods
		require_once dirname(dirname(__FILE__)) .'/upgrade/class.dataframe_v7_migration.php';

	// DATAFRAME : Migrate dataframe pairing locators to the unified v7 contract
	// (type: DEDALO_RELATION_TYPE_DATAFRAME, id_key = main item id; drops legacy
	// section_id_key/section_tipo_key). Covers matrix tables, time machine and
	// activity log. Unresolvable entries are left as legacy (dual-read) and reported.
	// Idempotent: already-migrated locators are skipped.
	// Dry-run available via: dataframe_v7_migration::migrate_all(false)
		$updates->$v->run_scripts[] = (object)[
			'info'			=> 'Migrate dataframe pairing locators (matrix tables) to the unified v7 contract: type marker + id_key (main item id)',
			'script_class'	=> 'dataframe_v7_migration',
			'script_method'	=> 'migrate_matrix',
			'stop_on_error'	=> true,
			'script_vars'	=> [
				null, // ar_tables. null = discover matrix tables with a relation column
				true // save option. On false, only data review is made. Not save
			] // Note that only ONE argument encoded is sent
		];

		$updates->$v->run_scripts[] = (object)[
			'info'			=> 'Migrate dataframe pairing locators (matrix_time_machine) to the unified v7 contract',
			'script_class'	=> 'dataframe_v7_migration',
			'script_method'	=> 'migrate_time_machine',
			'stop_on_error'	=> false,
			'script_vars'	=> [
				true // save option. On false, only data review is made. Not save
			] // Note that only ONE argument encoded is sent
		];

		$updates->$v->run_scripts[] = (object)[
			'info'			=> 'Migrate dataframe pairing locators (matrix_activity payloads, literal mains) to the unified v7 contract',
			'script_class'	=> 'dataframe_v7_migration',
			'script_method'	=> 'migrate_activity',
			'stop_on_error'	=> false,
			'script_vars'	=> [
				true // save option. On false, only data review is made. Not save
			] // Note that only ONE argument encoded is sent
		];

		// Materialise deprecated component_iri inline title strings as proper label
		// dataframe records and strip the literal title from the IRI locator.
		// See memory note: IRI 'id' pairs value with label dataframe — the id_key
		// must survive this migration so label look-ups remain intact.
		$updates->$v->run_scripts[] = (object)[
			'info'			=> 'Materialize deprecated component_iri literal titles into label dataframe records, then strip the literal title',
			'script_class'	=> 'dataframe_v7_migration',
			'script_method'	=> 'materialize_iri_titles',
			'stop_on_error'	=> false,
			'script_vars'	=> [
				true // save option. On false, only data review is made. Not save
			] // Note that only ONE argument encoded is sent
		];

	// SECTION_ID INT UNIFICATION (v7 WC-2026-08-10-section-id-int-canonical).
	// Converts every locator-carried section_id/section_id_key/parent_section_id
	// stored as a convertible string into the canonical INT form, across all
	// migrated content tables + matrix_time_machine + dd_ontology.relations.
	// External-service locators (skip-tipo list below + the leading-zero rule)
	// are never cast — the string IS the remote id. Junk ('', 'null', tokens)
	// is REPORTED, never cast and never deleted here (operator-adjudicated
	// purging lives in the v7 repair script). Writes the section_id_int_normalize
	// marker row into matrix_updates on success.
	// (!) Ordered AFTER the reformat/dataframe migrations (their output is what
	// gets intified) and BEFORE the string-search/relation-index stores, so the
	// derived stores backfill from int-form locators. Idempotent.
		$updates->$v->run_scripts[] = (object)[
			'info'			=> 'Unify section_id as INT inside every stored locator (jsonb columns + time machine + dd_ontology); external remote ids kept verbatim',
			'script_class'	=> 'v6_to_v7',
			'script_method'	=> 'intify_section_id_locators',
			'stop_on_error'	=> true,
			'script_vars'	=> [
				null,		// ar_tables. null = the full default sweep set
				true,		// save option. On false, only data review is made. Not save
				['zenon1']	// skip_tipos: external-service sections whose locator ids are remote ids
			] // Note that only ONE argument encoded is sent
		];

	// STRING SEARCH STORE : Create the v7 per-value text-search store
	// (matrix_string_search: btree_gin extension, table, sync triggers on every
	// string-searchable matrix table, composite trigram index) and BACKFILL it
	// from the migrated data. (!) Deliberately the LAST step: it needs
	// recreate_db_assets (f_unaccent, pg_trgm) and must read the FINAL v7
	// string data (all prior migrations done) — later writes stay in sync via
	// the triggers. The TS engine gates its search pre-filter on trigger
	// presence, so triggers without the backfill would wrongly EXCLUDE records
	// from searches (stop_on_error=true). Idempotent: DDL is IF NOT EXISTS /
	// OR REPLACE, backfill is TRUNCATE + re-insert.
		$updates->$v->run_scripts[] = (object)[
			'info'			=> 'Create the v7 text-search store (matrix_string_search): table, sync triggers and trigram index, backfilled from the migrated data',
			'script_class'	=> 'v6_to_v7',
			'script_method'	=> 'create_string_search_store',
			'stop_on_error'	=> true,
			'script_vars'	=> [
			] // Note that only ONE argument encoded is sent
		];

	// RELATION INDEX : Create the v7 per-locator relation index
	// (matrix_relation_index: table, sync triggers, three btree indexes) and
	// BACKFILL it from the migrated data. Same LAST-step rationale as the
	// string search store: the TS engine gates its inverse-search fast path on
	// trigger presence + a non-empty index (empty = wrongly excluded rows), so
	// backfill is part of the correctness contract (stop_on_error=true).
	// Idempotent: DDL is IF NOT EXISTS / OR REPLACE, backfill is TRUNCATE +
	// re-insert. NOT the v6 `relations` table: DB-trigger-maintained, three
	// lean indexes, content tables only, keeps the locator type.
		$updates->$v->run_scripts[] = (object)[
			'info'			=> 'Create the v7 relation index (matrix_relation_index): table, sync triggers and btree indexes, backfilled from the migrated data',
			'script_class'	=> 'v6_to_v7',
			'script_method'	=> 'create_relation_index_store',
			'stop_on_error'	=> true,
			'script_vars'	=> [
			] // Note that only ONE argument encoded is sent
		];

	// Cleanup [2/2]: drop legacy 'datos' from the AUTH tables only.
	// (!) MUST BE THE VERY LAST STEP OF THE DESCRIPTOR — this is what finally makes
	// the install v6-unusable, so nothing that takes real time may run after it.
	// The v7 typed columns (data/relation/string/…) are ADDED alongside 'datos',
	// never renamed over it, so until this runs v6 can still read matrix_users and
	// authenticate. On a large install the tail of this pipeline (dataframe
	// migration → section_id intify → the search and relation-index backfills) runs
	// for hours; dropping this before it locked the operator out for the whole
	// window — the browser session expires and matrix_users can no longer be read
	// by v6, so the migration could not even be monitored.
	// The record tables lost their 'datos' back at [1/2], so this window allows
	// logging in and watching, NOT editing: a v6 record save errors out instead of
	// writing to a column that is about to be deleted.
	// stop_on_error=false: if the column was already dropped the IF EXISTS guard
	// in the method makes this a no-op; the pipeline should still complete.
		$updates->$v->run_scripts[] = (object)[
			'info'			=> 'DROP legacy "datos" column in the auth matrix tables (Final cleanup — ends v6 login)',
			'script_class'	=> 'v6_to_v7',
			'script_method'	=> 'drop_legacy_datos_column',
			'stop_on_error'	=> false,
			'script_vars'	=> [
				$ar_tables_auth
			] // Note that only ONE argument encoded is sent
		];
