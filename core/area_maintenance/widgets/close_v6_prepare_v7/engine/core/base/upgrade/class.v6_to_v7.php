<?php declare(strict_types=1);
/**
* CLASS V6_TO_V7
* One-shot migration helper that upgrades a Dédalo v6 PostgreSQL database to the v7 schema.
*
* Responsibilities:
* - Transforms the legacy `jer_dd` ontology table into the v7 `dd_ontology` table,
*   renaming columns and converting 'si'/'no' booleans.
* - Migrates all data matrices from the v6 monolithic `datos` JSONB blob to the v7
*   columnar layout (data, relation, string, date, iri, geo, number, media, misc, meta).
* - Migrates the Time Machine table (`matrix_time_machine`) to the v7 schema,
*   adding `user_id`, `bulk_process_temp`/`bulk_process_id`, and `data` columns.
* - Cleans up obsolete indexes, constraints, and user-defined functions that are
*   incompatible with the v7 schema.
* - Migrates search preset records from the v6 filter format to the v7 id-bearing format.
*
* Usage flow (invoked by the upgrade controller, never directly by user code):
*   1. pre_update()         — runs before logout; migrates ontology table.
*   2. reformat_matrix_data()  — converts all data matrices row-by-row.
*   3. reformat_matrix_time_machine_data() — converts TM rows.
*   4. Various schema-cleanup helpers (delete_v6_db_indexes, rename_constraint,
*      recreate_db_assets, drop_legacy_datos_column, etc.).
*
* All methods are static. The class is never instantiated.
* Relates to: update (tables_rows_iterator, convert_table_data),
*             db_tasks (create_extensions, rebuild_constraints, rebuild_indexes, …),
*             matrix_db_manager (exec_sql, exec_search),
*             tm_db_manager (delete), DBi, ontology_node.
*
* @package Dédalo
* @subpackage Core
*/
// Structural repair + finding classification used by reformat_matrix_data().
// Required explicitly (not autoloaded): the SPL autoloader maps a class name to a
// directory of the same name, and this class lives beside its only consumer.
require_once __DIR__ . '/class.v6_to_v7_normalize.php';

class v6_to_v7 {

	/**
	* Name of the legacy v6 ontology table. Kept as a class property to allow
	* subclass or test overrides without changing every SQL statement.
	* @var string $table_jer_dd
	*/
	public static string $table_jer_dd = 'jer_dd';

	/**
	* Name of the v7 ontology table created from `jer_dd` during pre_update().
	* The login process requires at least the `dd` TLD row to be present here.
	* @var string $table_dd_ontology
	*/
	public static string $table_dd_ontology = 'dd_ontology';

	/**
	* Name of the Time Machine audit table migrated by recreate_tm_table() and
	* reformat_matrix_time_machine_data().
	* @var string $table_matrix_time_machine
	*/
	public static string $table_matrix_time_machine = 'matrix_time_machine';



	/**
	 * PRE_UPDATE
	 *
	 * Executes the pre-update process, which runs after installing new code but BEFORE Dédalo logs out
	 * of the session to proceed with data, ontology, and tools updates.
	 *
	 * Update process flow:
	 * 1. Update code
	 * 2. Run pre_update (this method)
	 * 3. Log out
	 * 4. Log in
	 * 5. Update ontology
	 * 6. Update data
	 * 7. Update tools
	 * 8. Log out
	 *
	 * This process moves data from the legacy `jer_dd` table to the new `dd_ontology` table.
	 * It must run before log-out because the new code depends on the `dd_ontology` table,
	 * and the login process requires valid ontology nodes (at least the `dd` TLD).
	 *
	 * CRITICAL: If this process fails, Dédalo will stop working!
	 *
	 * @return object Standard response object with 'result' (bool), 'msg' (string), and 'errors' (array).
	 */
	public static function pre_update() : object {

		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Pre update has failed';
			$response->errors	= [];

		// 0. Change notifications table column name (datos -> data).
		// This must be done before because the update process uses the notifications table
		// to store the PID of the process updated data.
		$result = v6_to_v7::change_notifications_table_column_name();

		if($result === false){
			$response->errors[] = 'Failed to change notifications table column name';
			return $response;
		}

		// 1. Add new columns to 'jer_dd'
		$result = v6_to_v7::expand_jer_dd_with_new_schema();

		if($result === false){
			$response->errors[] = 'Failed to expand jer_dd with new schema';
			return $response;
		}

		// 2. Fill the 'jer_dd' new columns with the compatible data
		$result = v6_to_v7::fill_new_columns_in_jer_dd();

		if($result === false){
			$response->errors[] = 'Failed to fill new columns in jer_dd';
			return $response;
		}

		// 3. Change the 'jer_dd' relations data to be coherent
		$result = v6_to_v7::refactor_jer_dd_relations();

		if($result === false){
			$response->errors[] = 'Failed to refactor jer_dd relations';
			return $response;
		}

		// 4. Create the new 'dd_ontology' table and set the columns with correct data
		$result = v6_to_v7::create_dd_ontology_table();

		if($result === false){
			$response->errors[] = 'Failed to create dd_ontology table';
			return $response;
		}

		$response->result = true;
		$response->msg = 'Pre update was done';


		return $response;
	}//end pre_update



	/**
	 * EXPAND_JER_DD_WITH_NEW_SCHEMA
	 *
	 * Modifies the `jer_dd` table structure by adding new columns aligned with the v7 schema.
	 *
	 * Mapping summary:
	 * - 'terminoID'    => 'tipo'
	 * - 'modelo'       => 'model_tipo'
	 * - 'esmodelo'     => 'is_model'
	 * - 'traducible'   => 'is_translatable'
	 * - 'tld+0'        => 'is_main'
	 * - 'norden'       => 'order_number'
	 * - 'relaciones'   => 'relations'
	 *
	 * @return bool True if the schema was successfully expanded, false otherwise.
	 */
	public static function expand_jer_dd_with_new_schema() : bool {

		$sql_query = sanitize_query ('
			ALTER TABLE "' . static::$table_jer_dd . '"
				ADD COLUMN IF NOT EXISTS "tipo" character varying(32) NULL,
				ADD COLUMN IF NOT EXISTS "model_tipo" character varying(8) NULL,
				ADD COLUMN IF NOT EXISTS "is_model" boolean NULL,
				ADD COLUMN IF NOT EXISTS "is_translatable" boolean NULL,
				ADD COLUMN IF NOT EXISTS "is_main" boolean NULL,
				ADD COLUMN IF NOT EXISTS "order_number" numeric(4,0) NULL,
				ADD COLUMN IF NOT EXISTS "relations" jsonb NULL;
		');

		$result = matrix_db_manager::exec_sql($sql_query);

		if($result===false) {
			$msg = "Failed to expand jer_dd with a new schema";
			debug_log(__METHOD__
				." ERROR: $msg "
				, logger::ERROR
			);
			return false;
		}

		return true;
	}//end expand_jer_dd_with_new_schema



	/**
	 * FILL_NEW_COLUMNS_IN_JER_DD
	 *
	 * Populates the newly created columns in `jer_dd` with transformed data from existing v6 columns.
	 * Converts legacy 'si'/'no' strings to boolean values.
	 *
	 * @return bool True if data was successfully filled, false otherwise.
	 */
	public static function fill_new_columns_in_jer_dd() : bool {

		// Check if source column exists (terminoID is representative of all old columns)
		$terminoID_exists = DBi::check_column_exists(static::$table_jer_dd, 'terminoID');
		if(!$terminoID_exists) {
			debug_log(__METHOD__
				." WARNING: Ignore fill_new_columns_in_jer_dd because terminoID column does not exist"
				, logger::WARNING
			);
			return true;
		}

		$sql_query = sanitize_query ('
			UPDATE "' . static::$table_jer_dd . '"
				SET tipo 			= "terminoID",
					model_tipo 		= modelo,
					order_number	= norden,
					is_model 		= CASE WHEN esmodelo = \'si\' THEN true ELSE false END,
					is_translatable	= CASE WHEN traducible = \'si\' THEN true ELSE false END,
					is_main			= CASE WHEN "terminoID" = CONCAT(tld, 0) THEN true ELSE false END;
		');

		$result = matrix_db_manager::exec_sql($sql_query);

		if($result===false) {
			$msg = "Failed to fill new columns in jer_dd";
			debug_log(__METHOD__
				." ERROR: $msg "
				, logger::ERROR
			);
			return false;
		}

		return true;
	}//end fill_new_columns_in_jer_dd



	/**
	 * REFACTOR_JER_DD_RELATIONS
	 *
	 * Standardizes the relationship data in `jer_dd`. Legacy relations could be stored as objects
	 * keyed by model. This refactors them into a consistent array of objects with a 'tipo' key.
	 *
	 * Example transformation:
	 * From: [{"model_x": "dd64"}]
	 * To:   [{"tipo": "dd64"}]
	 *
	 * @return bool True if relations were successfully refactorized, false otherwise.
	 */
	public static function refactor_jer_dd_relations() : bool {

		// jer_dd. delete terms (jer_dd)
			$sql_query = "
				SELECT id, relaciones FROM \"" . static::$table_jer_dd . "\";
			";
			$jer_dd_result = matrix_db_manager::exec_search($sql_query, [], false);

		if (!$jer_dd_result) {
			return false;
		}

		// iterate jer_dd_result row
		while($row = pg_fetch_assoc($jer_dd_result)) {

			$relaciones	= $row['relaciones'];
			$id			= $row['id'];

			if (empty($relaciones)) {
				continue;
			}

			$relations = json_handler::decode($relaciones) ?? [];

			$ar_relations = [];
			foreach ($relations as $item) {
				if (is_array($item) || $item instanceof stdClass) {
					foreach ($item as $value) {
						$relation = new stdClass();
							$relation->tipo = $value;
						$ar_relations[] = $relation;
					}
				}
			};

			$new_relation = ( empty($ar_relations) ) ? null : $ar_relations;

			$string_relation_object = json_handler::encode($new_relation);

			$strQuery = "UPDATE \"" . static::$table_jer_dd . "\" SET relations = $1 WHERE id = $2 ";
			$result   = pg_query_params(DBi::_getConnection(), $strQuery, [$string_relation_object, $id]);
			if($result===false) {
				$msg = "Failed to update relations in section_data (jer_dd) for ID $id";
				debug_log(__METHOD__
					." ERROR: $msg "
					, logger::ERROR
				);
				return false;
			}
		}

		pg_free_result($jer_dd_result);

		return true;
	}//end refactor_jer_dd_relations



	/**
	 * CREATE_DD_ONTOLOGY_TABLE
	 *
	 * Creates the `dd_ontology` table by selecting data from the upgraded `jer_dd` table.
	 * Configures the sequence, primary key, and adds comments to the new schema.
	 *
	 * @return bool True if the table was successfully created and configured, false otherwise.
	 */
	public static function create_dd_ontology_table() : bool {

		$sql_query = sanitize_query ('
			CREATE TABLE IF NOT EXISTS "' . static::$table_dd_ontology . '" AS
				SELECT id, tipo, parent, term, model, order_number, relations, tld, properties, model_tipo, is_model, is_translatable, is_main, propiedades
			FROM "' . static::$table_jer_dd . '";

			COMMENT ON TABLE "' . static::$table_dd_ontology . '" IS  \'Active ontology\';

			CREATE SEQUENCE IF NOT EXISTS "' . static::$table_dd_ontology . '_id_seq" OWNED BY "' . static::$table_dd_ontology . '"."id";

			ALTER TABLE "' . static::$table_dd_ontology . '"
			ALTER "id" TYPE integer,
			ALTER "id" SET DEFAULT nextval(\'' . static::$table_dd_ontology . '_id_seq\'),
			ALTER "id" SET NOT NULL;

			ALTER TABLE "' . static::$table_dd_ontology . '"
			DROP CONSTRAINT IF EXISTS ' . static::$table_dd_ontology . '_id_pkey;

			ALTER TABLE "' . static::$table_dd_ontology . '"
			ADD CONSTRAINT ' . static::$table_dd_ontology . '_id_pkey
			PRIMARY KEY ( id );

			ALTER TABLE "' . static::$table_dd_ontology . '"
			DROP CONSTRAINT IF EXISTS ' . static::$table_dd_ontology . '_tipo_key;

			ALTER TABLE "' . static::$table_dd_ontology . '"
			ADD CONSTRAINT ' . static::$table_dd_ontology . '_tipo_key
			UNIQUE ( tipo );

			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.id IS \'Unique table identifier\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.tipo IS \'Ontology identifier (ontology TLD | ontology instance ID, e.g., oh1 = Oral History)\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.parent IS \'Ontology identifier parent (ontology TLD | ontology instance ID, e.g., tch1 = Tangible Cultural Heritage -> Objects)\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.term IS \'Ontology node names in multiple languages\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.model IS \'Ontology model name as section, component_portal, etc.\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.order_number IS \'Ontology node position order\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.relations IS \'Direct connections between nodes, unidirectional\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.tld IS \'Ontology name space\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.properties IS \'Ontology node definition\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.model_tipo IS \'Ontology identifier for the node type,  e.g., dd6 = section\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.is_model IS \'Boolean to identify if the node is a type of nodes\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.is_translatable IS \'Boolean to identify if the node is a multilingual node\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.is_main IS \'Boolean to identify if the node is a main/root node (tipo = tld + 0)\';
			COMMENT ON COLUMN ' . static::$table_dd_ontology . '.propiedades IS \'V5 properties, DEPRECATED\';

			-- Optionally drop the old one and rename
			-- DROP TABLE IF EXISTS "' . static::$table_jer_dd . '" CASCADE;
			-- DROP SEQUENCE IF EXISTS ' . static::$table_jer_dd . '_id_seq;
		');

		$result = matrix_db_manager::exec_sql($sql_query);

		if($result===false) {
			$msg = "Failed to create dd_ontology table from jer_dd";
			debug_log(__METHOD__
				." ERROR: $msg "
				, logger::ERROR
			);
			return false;
		}

		return true;
	}//end create_dd_ontology_table



	/**
	* GET_VALUE_TYPE_MAP
	* Returns a map from component model name to the DEDALO_VALUE_TYPE_* constant that
	* determines which v7 columnar slot (string, number, date, media, iri, geo, misc)
	* the migrated data must be placed in.
	*
	* Only component models that require explicit type routing are listed here.
	* Any model absent from this map defaults to DEDALO_VALUE_TYPE_MISC → 'misc' column.
	* Relation-bearing components (component_relation_*) are handled separately and
	* are intentionally omitted.
	*
	* Called once per batch in reformat_matrix_data() and reformat_matrix_time_machine_data()
	* and cached locally; calling it per-row would be needlessly expensive.
	*
	* @return object Keyed by model name, values are DEDALO_VALUE_TYPE_* string constants.
	*/
	private static ?object $value_type_map_cache = null;

	public static function get_value_type_map() : object {

		if (self::$value_type_map_cache === null) {
			self::$value_type_map_cache = (object)[
				'component_input_text'		=>	DEDALO_VALUE_TYPE_STRING,
				'component_text_area'		=>	DEDALO_VALUE_TYPE_STRING,
				'component_email'			=>	DEDALO_VALUE_TYPE_STRING,
				'component_password'		=>	DEDALO_VALUE_TYPE_STRING,
				'component_number'			=>	DEDALO_VALUE_TYPE_NUMBER,
				'component_date'			=>	DEDALO_VALUE_TYPE_DATE,
				'component_3d'				=>	DEDALO_VALUE_TYPE_MEDIA,
				'component_av'				=>	DEDALO_VALUE_TYPE_MEDIA,
				'component_image'			=>	DEDALO_VALUE_TYPE_MEDIA,
				'component_pdf'				=>	DEDALO_VALUE_TYPE_MEDIA,
				'component_svg'				=>	DEDALO_VALUE_TYPE_MEDIA,
				'component_iri'				=>	DEDALO_VALUE_TYPE_IRI,
				'component_geolocation'		=>	DEDALO_VALUE_TYPE_GEO,
				'component_json'			=>	DEDALO_VALUE_TYPE_MISC,
				'component_filter_records'	=>	DEDALO_VALUE_TYPE_MISC,
				'component_security_access'	=>	DEDALO_VALUE_TYPE_MISC
			];
		}
		return self::$value_type_map_cache;
	}//end get_value_type_map



	/**
	* CONVERT_TABLE_DATA
	* Thin delegation wrapper that forwards to update::convert_table_data().
	*
	* Exists so that upgrade scripts can call v6_to_v7::convert_table_data() without
	* depending on the update class name directly.
	*
	* @param array $ar_tables - list of matrix table names to operate on.
	* @param string $action   - action identifier passed through to update::convert_table_data().
	* @return bool - result of update::convert_table_data(); true on success.
	*/
	public static function convert_table_data(array $ar_tables, string $action) : bool {

		return update::convert_table_data($ar_tables, $action);
	}//end convert_table_data



	/**
	 * REFORMAT_MATRIX_DATA
	 *
	 * Converts legacy v6 data format (single 'datos' JSON blob) to the new v7 columnar data format.
	 * Distributes data from the v6 'datos' field into specialized columns like 'data', 'relation',
	 * 'string', 'date', etc., based on component typology.
	 *
	 * Example usage:
	 * ```php
	 * $ar_tables = ['matrix', 'matrix_activities'];
	 * $save = true; // Set to false for a dry-run check
	 * $response = v6_to_v7::reformat_matrix_data($ar_tables, $save);
	 * ```
	 *
	 * @param array $ar_tables List of database tables to process.
	 * @param bool $save If true, saves changes to DB. If false, only performs a data review.
	 * @return object Standard response object.
	 */
	public static function reformat_matrix_data( array $ar_tables, bool $save ) : object {

		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Error. Request failed';
			$response->errors	= [];

		// Fresh aggregation for this pass. A single process can run the review (save=false)
		// and then the migration (save=true); the second must not inherit the first's counts.
		v6_to_v7_normalize::reset();

		debug_log(__METHOD__ . PHP_EOL
			. ' ))))))))))))))))))))))))))))))))))))))))))))))))))))))) ' . PHP_EOL
			. ' CONVERTING ... ' . PHP_EOL
			. ' reformat_matrix_data - tables: ' . json_handler::encode($ar_tables) . PHP_EOL
			. ' ))))))))))))))))))))))))))))))))))))))))))))))))))))))) ' . PHP_EOL
			, logger::WARNING
		);

		// Pre-fetch value type map once
		// Avoids a redundant object construction for every row; the map is read-only
		// and shared across the closure via 'use'.
		$value_type_map = v6_to_v7::get_value_type_map();

		// CLI process data initialization
		// common::$pdata is a shared status object polled by the CLI shell to display
		// live progress without flooding stdout with full log lines.
		if ( running_in_cli()===true ) {
			if (!isset(common::$pdata)) {
				common::$pdata = new stdClass();
			}
			common::$pdata->table = '';
			common::$pdata->memory = '';
			common::$pdata->counter = 0;
		}

		$conn = DBi::_getConnection();
		// Escaped-table cache
		// pg_escape_identifier() is called once per unique table name and cached here
		// because the iterator visits thousands of rows per table.
		$ar_escaped_tables = [];

		// iterate tables
		// update::tables_rows_iterator streams rows in batches, calling the closure for
		// each row. Using a streaming cursor avoids loading the entire table into memory.
		update::tables_rows_iterator(
			$ar_tables,
			function($row, $table, $max) use ($response, $save, $conn, $value_type_map, &$ar_escaped_tables) {

				$id				= $row['id'];
				$section_tipo	= $row['section_tipo'] ?? null;
				// Decode the legacy v6 monolithic blob; null when the column is absent or empty.
				$datos			= (isset($row['datos'])) ? json_handler::decode($row['datos']) : null;
				$section_id		= $row['section_id'] ?? '';

				// CLI process data status
				// Memory is sampled only every 5 000 rows to avoid calling memory_get_usage()
				// on every iteration, which would add measurable overhead over millions of rows.
				if ( running_in_cli()===true ) {
					common::$pdata->msg	= (label::get_label('processing') ?? 'Processing') . ': ' . __METHOD__
						. ' | table: '			. $table
						. ' | id: '				. $id .' - ' . $max
						. ' | section_tipo: '	. $section_tipo
						. ' | section_id: '		. ($row['section_id'] ?? '');
					common::$pdata->memory = (common::$pdata->counter % 5000 === 0)
						? dd_memory_usage()
						: common::$pdata->memory;
					common::$pdata->table = $table;
					common::$pdata->section_tipo = $section_tipo;
					common::$pdata->counter++;
					print_cli(common::$pdata);
				}

				// datos properties
				// Rows without a 'datos' value (already migrated or empty) are skipped silently.
				if( isset($datos) ){

					$processed_data = self::process_matrix_row_data(
						$datos,
						$table,
						$section_tipo,
						$section_id,
						$value_type_map,
						$response
					);

					// Build the ordered parameter array for the UPDATE statement.
					// Empty column objects (no keys) are stored as SQL NULL to preserve
					// storage efficiency; the v7 search layer treats NULL and empty-object
					// identically when querying JSONB columns.
					$data_cols = [
						'data'            => $processed_data->data,
						'relation'        => $processed_data->relation,
						'string'          => $processed_data->string,
						'date'            => $processed_data->date,
						'iri'             => $processed_data->iri,
						'geo'             => $processed_data->geo,
						'number'          => $processed_data->number,
						'media'           => $processed_data->media,
						'misc'            => $processed_data->misc,
						'relation_search' => $processed_data->relation_search,
						'meta'            => $processed_data->meta,
					];

					$params = [];
					foreach ($data_cols as $col_name => $col_obj) {
						$params[] = ( empty(get_object_vars($col_obj)) ) ? null : json_handler::encode($col_obj);
					}
					$params[] = $id;

					if (!isset($ar_escaped_tables[$table])) {
						$ar_escaped_tables[$table] = pg_escape_identifier($conn, $table);
					}
					$escaped_table = $ar_escaped_tables[$table];

					$strQuery = '
						UPDATE ' . $escaped_table . '
						SET data = $1,
							relation = $2,
							string = $3,
							date = $4,
							iri = $5,
							geo = $6,
							number = $7,
							media = $8,
							misc = $9,
							relation_search = $10,
							meta = $11
						WHERE id = $12
					';

					if ($save) {
						$result = matrix_db_manager::exec_search($strQuery, $params, false);
					} else {
						$result = true;
					}

					if($result===false) {
						$msg = "Failed Update section_data ($table) $id";
						debug_log(__METHOD__
							." ERROR: $msg "
							, logger::ERROR
						);
						$response->errors[] = "Error on SQL execution for ID $id. Table: $table";
						return; // Return from closure
					}
				}
			}//end callback function
		);

		$response->result	= empty($response->errors);
		$response->msg		= empty($response->errors)
			? 'Request done successfully'
			: 'Request done with errors (' . count($response->errors) . ')';

		return $response;
	}//end reformat_matrix_data



	/**
	 * PROCESS_MATRIX_ROW_DATA
	 *
	 * Processes a single legacy v6 row (datos JSON blob) and distributes its content into
	 * specialized v7 column objects based on component typology.
	 *
	 * @param array|object $datos Legacy data blob from v6.
	 * @param string $table Target table name.
	 * @param string $section_tipo Section typology.
	 * @param mixed $section_id Section record ID.
	 * @param object $value_type_map Map of model names to DEDALO_VALUE_TYPE constants.
	 * @param object $response (by reference) Standard response object for error tracking.
	 * @return object Object containing individual column datasets.
	 */
	public static function process_matrix_row_data($datos, string $table, string $section_tipo, $section_id, object $value_type_map, &$response) : object {

		$results = (object)[
			'data'            => new stdClass(),
			'relation_search' => new stdClass(),
			'relation'        => new stdClass(),
			'string'          => new stdClass(),
			'date'            => new stdClass(),
			'number'          => new stdClass(),
			'geo'             => new stdClass(),
			'media'           => new stdClass(),
			'iri'             => new stdClass(),
			'misc'            => new stdClass(),
			'meta'            => new stdClass()
		];

		// Column routing map
		// Maps each DEDALO_VALUE_TYPE_* constant to the property name on $results
		// that holds the corresponding v7 column data. Absent types fall through
		// to 'misc' as the safe default.
		$column_map = [
			DEDALO_VALUE_TYPE_STRING => 'string',
			DEDALO_VALUE_TYPE_NUMBER => 'number',
			DEDALO_VALUE_TYPE_DATE   => 'date',
			DEDALO_VALUE_TYPE_MEDIA  => 'media',
			DEDALO_VALUE_TYPE_IRI    => 'iri',
			DEDALO_VALUE_TYPE_GEO    => 'geo',
			DEDALO_VALUE_TYPE_MISC   => 'misc'
		];

		foreach ($datos as $datos_key => $datos_value) {
			if (empty($datos_value)) continue;

			switch ($datos_key) {
				case 'relations_search':
				case 'relations':
					// Relation routing
					// v6 stored both live relations ('relations') and the search-index
					// copy ('relations_search') inside the same datos blob. v7 separates
					// them into two distinct JSONB columns: 'relation' and 'relation_search'.
					$target_key = ($datos_key === 'relations_search') ? 'relation_search' : 'relation';
					foreach ($datos_value as $locator) {
						// A locator with no from_component_tipo cannot be routed to a component
						// column, and there is no safe way to infer the source: leave it as an
						// error the operator has to look at.
						if (!isset($locator->from_component_tipo)) {
							$locator_string = json_handler::encode($locator);
							debug_log(__METHOD__ . " ERROR: locator without from_component_tipo in $table/$section_id. locator: $locator_string", logger::ERROR);
							v6_to_v7_normalize::add(
								$response,
								'LOCATOR_NO_SOURCE',
								v6_to_v7_normalize::SEVERITY_ERROR,
								[
									'table'			=> $table,
									'section_tipo'	=> $section_tipo,
									'section_id'	=> $section_id,
									'tipo'			=> $datos_key,
									'model'			=> ''
								],
								"Bad component data (locator without from_component_tipo property). table: '$table' section_tipo: '$section_tipo' section_id: '$section_id'",
								$locator
							);
							continue;
						}

						// Skip deprecated activity project link
						// dd550 was a v5/v6 internal link from activities to their project; it has no
						// equivalent in v7 and must be discarded during migration.
						if ($locator->from_component_tipo === 'dd550') continue;

						$comp_tipo = $locator->from_component_tipo;
						if (!isset($results->{$target_key}->{$comp_tipo})) {
							$results->{$target_key}->{$comp_tipo} = [];
						}
						$results->{$target_key}->{$comp_tipo}[] = $locator;
					}

					// Assign sequential ids and meta counters to live relations
					// v7 requires every locator to carry a numeric 'id' field (1-based) and a
					// corresponding meta entry {count: N} so the UI can manage additions/deletions
					// without re-querying counts from the DB.
					if ($datos_key === 'relations') {
						foreach ($results->relation as $comp_tipo => $rel_data) {
							foreach ($rel_data as $i => $locator) {
								$locator->id = $i + 1;
								$results->meta->{$comp_tipo} = [(object)['count' => $i + 1]];
							}
						}
					}
					break;

				case 'components':
					foreach ($datos_value as $literal_tipo => $literal_value) {

						// Resolve component model
						// ontology_node::get_model_by_tipo() returns the PHP class name without the
						// 'class.' prefix, e.g. 'component_input_text', or null for unknown tipos.
						$model = ontology_node::get_model_by_tipo($literal_tipo);

						// Skip v5 legacy components columns
						// component_filter and component_section_id were v5 internal pseudo-components
						// that stored filter configuration inside the data matrix. v7 does not use them.
						if (in_array($model, ['component_filter', 'component_section_id'])) continue;

						// Get target column based on typology
						$typology   = $value_type_map->{$model} ?? DEDALO_VALUE_TYPE_MISC;
						$target_col = $column_map[$typology] ?? 'misc';

						// Missing 'dato' envelope.
						// Most of these are mechanical: v6 stored the lang map itself
						// ({"lg-nolan":[…]}) where v7 expects it wrapped ({"dato":{…}}), or the
						// value is simply empty. v6_to_v7_normalize repairs what is provably
						// safe to repair, records the finding with its severity, and returns
						// false only when there is genuinely nothing to migrate.
						if (!isset($literal_value->dato)) {
							debug_log(__METHOD__ . " Literal without v6 'dato' property ($literal_tipo) in $table/$section_id", logger::WARNING);
							$normalized = v6_to_v7_normalize::component_value(
								$literal_tipo,
								$literal_value,
								$table,
								$section_tipo,
								$section_id,
								$model,
								$response
							);
							if ($normalized === false) {
								continue;
							}
							$literal_value = $normalized;
						}

						$value_key = 0;
						foreach ($literal_value->dato as $lang => $ar_value) {

							// Skip empty values
							if (empty($ar_value) && $ar_value !== '0') continue;

							// Migrate data (Add 'id' property to each value, normalize data as array, set 'lang' property if missing)
							$migrate_component_data_response = self::migrate_component_data(
								$literal_tipo,
								$ar_value,
								$lang,
								$section_tipo,
								$section_id,
								$value_key,
								$model,
								v6_to_v7_normalize::stored_model($literal_value)
							);

							// Fold in the findings ALWAYS, not only when the value was dropped.
							// migrate_component_data has no idea which table it was called for, so the
							// table is stamped on here.
							// (!) A REPAIR is a SUCCESSFUL migration: merging only on ->result === false
							// would make every repaired value silent, and a silent repair is the one
							// thing this registry exists to prevent. Nothing is double-counted —
							// defer() never touches ->errors, and merge() replays ->findings once.
							v6_to_v7_normalize::merge($response, $migrate_component_data_response, $table);

							if ($migrate_component_data_response->result === false) {
								// If the data isn't useful for saving (legacy garbage), this is not an
								// error, it's just a skip.
								continue;
							}

							// If the data is empty, skip it. Note the merge above already ran: an
							// emptied result is exactly what an all-default geolocation looks like.
							if(empty($migrate_component_data_response->result)) continue;

							// Set component data
							if (!isset($results->{$target_col}->{$literal_tipo})) {
								$results->{$target_col}->{$literal_tipo} = [];
							}
							$results->{$target_col}->{$literal_tipo} = array_merge(
								$results->{$target_col}->{$literal_tipo},
								$migrate_component_data_response->result
							);
						}//end foreach ($literal_value->dato as $lang => $ar_value)

						// Set component counter
						// get the last id iterating all items of all langs
						// Note that all langs share id across all items, like:
						// [{
						// 	id: 1,
						// 	lang: 'lg-spa'
						// },
						// {
						// 	id: 1,
						// 	lang: 'lg-eng'
						// }]
						if(isset($results->{$target_col}->{$literal_tipo})) {
							$last_id = 0;
							foreach ($results->{$target_col}->{$literal_tipo} as $value) {
								if (isset($value->id) && is_numeric($value->id) && (int)$value->id > $last_id) {
									$last_id = (int)$value->id;
								}
							}
							if($last_id > 0) {
								$results->meta->{$literal_tipo} = [(object)['count' => $last_id]];
							}
						}

						/* OLD WAY - Changed by new migrate_component_data function unified for time machine

						foreach ($literal_value->dato as $lang => $ar_value) {
							if (empty($ar_value) && $ar_value !== '0') continue;

							// Normalize non-array values (TinyMCE, etc.)
							if (!is_array($ar_value)) {
								if (($literal_tipo === 'hierarchy42' && $lang === 'lg-nolan') ||
									($ar_value === '<br data-mce-bogus="1">') ||
									($literal_tipo === 'dd23')) continue;

								$ar_value = [$ar_value];
							}

							$value_key = 0;
							foreach (array_values($ar_value) as $value) {
								if (!isset($value) || (empty($value) && $value !== '0')) continue;
								if (json_handler::encode($value) === '{"files_info":[]}') continue;

								// Skip old v5 media records pointing to self
								if (is_object($value) && isset($value->component_tipo) && $value->component_tipo === $literal_tipo &&
									isset($value->section_tipo) && $value->section_tipo === $section_tipo && $value->section_id == $section_id) continue;

								$value_key++;
								$results->meta->{$literal_tipo} = [(object)['count' => $value_key]];

								$typology = $value_type_map->{$model} ?? DEDALO_VALUE_TYPE_MISC;
								$target_col = $column_map[$typology] ?? 'misc';

								// Prepare object to store
								if ($typology === DEDALO_VALUE_TYPE_MISC &&
									in_array($model, ['component_security_access', 'component_info', 'component_filter_records']) &&
									is_object($value)) {
									$final_obj = $value;
									$final_obj->id = $value_key;
								} else {
									$final_obj = (object)[
										'id'    => $value_key,
										'value' => $value
									];
								}

								// Special handling for language-aware strings
								if ($typology === DEDALO_VALUE_TYPE_STRING) {
									$final_obj->lang = $lang;
								}

								// Check format for complex types (Date, Media, Geo, IRI)
								if (in_array($typology, [DEDALO_VALUE_TYPE_DATE, DEDALO_VALUE_TYPE_MEDIA, DEDALO_VALUE_TYPE_GEO, DEDALO_VALUE_TYPE_IRI])) {
									if (!is_object($value)) {
										$val_str = json_handler::encode($value);
										debug_log(__METHOD__ . " ERROR: component value ($literal_tipo) out of format in $table/$section_id: $val_str", logger::ERROR);
										$response->errors[] = "Bad component data (invalid format for $typology). table: '$table' tipo: '$literal_tipo'";
										continue 2;
									}
									// Update existing object properties
									$final_obj = $value;
									if (empty($final_obj->id) || $typology !== DEDALO_VALUE_TYPE_IRI) {
										$final_obj->id = $value_key;
									}
									if ($typology === DEDALO_VALUE_TYPE_IRI) {
										$final_obj->lang = $lang;
									}
								}

								if (!isset($results->{$target_col}->{$literal_tipo})) {
									$results->{$target_col}->{$literal_tipo} = [];
								}
								$results->{$target_col}->{$literal_tipo}[] = $final_obj;
							}
						}
						*/
					}
					break;

				case 'section_real_tipo':
					break; // Extinct property — was used in v5/v6 to track the canonical section type; dropped in v7.

				case 'created_by_userID':
					// Column rename: v6 used camelCase 'created_by_userID'; v7 uses snake_case.
					$results->data->created_by_user_id = $datos_value;
					break;

				default:
					// Scalar metadata pass-through
					// Properties like section_tipo, created_date, modified_date, and any future
					// top-level metadata are copied verbatim into the 'data' column object.
					$results->data->{$datos_key} = $datos_value;
					break;
			}
		}

		return $results;
	}//end process_matrix_row_data



	/**
	 * REFORMAT_MATRIX_TIME_MACHINE_DATA
	 *
	 * Converts legacy v6 data format (single 'datos' JSON blob) to the new v7 columnar data format.
	 *
	 * Example usage:
	 * ```php
	 * $ar_tables = ['matrix_time_machine'];
	 * $save = true; // Set to false for a dry-run check
	 * $response = v6_to_v7::reformat_matrix_time_machine_data($ar_tables, $save);
	 * ```
	 *
	 * @param array $ar_tables List of database tables to process.
	 * @param bool $save If true, saves changes to DB. If false, only performs a data review.
	 * @return object Standard response object.
	 */
	public static function reformat_matrix_time_machine_data( array $ar_tables, bool $save ) : object {

		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Error. Request failed';
			$response->errors	= [];

		debug_log(__METHOD__ . PHP_EOL
			. ' ))))))))))))))))))))))))))))))))))))))))))))))))))))))) ' . PHP_EOL
			. ' CONVERTING ... ' . PHP_EOL
			. ' reformat_matrix_time_machine_data - tables: ' . json_handler::encode($ar_tables) . PHP_EOL
			. ' ))))))))))))))))))))))))))))))))))))))))))))))))))))))) ' . PHP_EOL
			, logger::WARNING
		);

		// Suppress verbose logs during bulk update
		// When DEDALO_UPDATING is set, lower-level classes reduce their logging output
		// to avoid flooding the log file with millions of routine debug entries.
		$_ENV['DEDALO_UPDATING'] = true;

		// HISTORY IS NEVER REPAIRED. Makes the value-level repairs inert for this pass: a TM
		// row says what the data WAS, so rewriting it there falsifies the past. Rows whose
		// whole payload is the studio default map view are DELETED below instead.
		v6_to_v7_normalize::$history_pass = true;

		// Pre-fetch value type map once
		// Shared across the closure via 'use'; see get_value_type_map() for the contract.
		$value_type_map = v6_to_v7::get_value_type_map();

		// CLI process data initialization
		if ( running_in_cli()===true ) {
			if (!isset(common::$pdata)) {
				common::$pdata = new stdClass();
			}
			common::$pdata->table = '';
			common::$pdata->memory = '';
			common::$pdata->counter = 0;
		}

		$conn = DBi::_getConnection();
		$ar_escaped_tables = [];

		// iterate tables
		update::tables_rows_iterator(
			$ar_tables,
			function($row, $table, $max) use ($response, $save, $conn, $value_type_map, &$ar_escaped_tables) {

				$id				= $row['id'];
				$section_tipo	= $row['section_tipo'] ?? null;
				$data			= (isset($row['data'])) ? json_handler::decode($row['data']) : null;
				$section_id		= $row['section_id'] ?? '';
				$tipo			= $row['tipo'] ?? null;
				$lang			= $row['lang'] ?? null;

				// Garbage old data guard
				// 'termino' was a v5-era tipo value used for standalone thesaurus term records.
				// These rows have no equivalent in v7 and must be hard-deleted rather than
				// migrated; leaving them would cause type-resolution failures later.
				if( empty($tipo) || $tipo === 'termino' ) {
					// Delete it because it is old data garbage. Only when saving: a dry run
					// (save=false) deletes nothing, it reports (owner decision 2026-10-24).
					if ($save) {
						$deleted = tm_db_manager::delete( (int)$id );
						debug_log(__METHOD__ . " Ignored old data garbage for matrix_time_machine ID $id. Deleted: " . json_handler::encode($deleted), logger::DEBUG);
					}
					v6_to_v7_normalize::add(
						$response,
						'TM_GARBAGE_TIPO_ROW_DELETED',
						v6_to_v7_normalize::SEVERITY_FIXED,
						[
							'table'			=> $table,
							'section_tipo'	=> $section_tipo,
							'section_id'	=> $row['section_id'] ?? '',
							'tipo'			=> (string)$tipo,
							'model'			=> ''
						],
						'Time-machine row deleted: empty tipo or the v5 \'termino\' pseudo-tipo'
							. ' (standalone thesaurus term records), with no v7 equivalent.'
					);
					return;
				}

				// Test TLD rows: DELETE, before anything is migrated. The `test` TLD is the
				// Dédalo test suite's fixture namespace; its history has no place in an
				// installation, component and section rows alike (owner decision 2026-10-24).
				if (v6_to_v7::is_test_tld_tm_row($tipo, $section_tipo)) {
					if ($save) {
						tm_db_manager::delete( (int)$id );
					}
					v6_to_v7_normalize::add(
						$response,
						'TM_TEST_TLD_ROW_DELETED',
						v6_to_v7_normalize::SEVERITY_FIXED,
						[
							'table'			=> $table,
							'section_tipo'	=> $section_tipo,
							'section_id'	=> $row['section_id'] ?? '',
							'tipo'			=> v6_to_v7::TEST_TLD,
							'model'			=> ''
						],
						'Time-machine row deleted: its tipo or section_tipo belongs to the `test`'
							. ' TLD (test-suite fixtures), which has no place in an installation\'s history.'
					);
					return;
				}

				// Lang guard
				// Every TM component row must carry a language code. A row without one cannot
				// be routed to the correct columnar slot and is treated as corrupt.
				if( empty($lang) ) {
					// Grouped rather than appended row by row: the TM table is the largest in
					// the database, and one corrupt-lang row repeated a million times must not
					// become a million strings in memory.
					v6_to_v7_normalize::add(
						$response,
						'TM_NO_LANG',
						v6_to_v7_normalize::SEVERITY_ERROR,
						[
							'table'			=> $table,
							'section_tipo'	=> $section_tipo,
							'section_id'	=> $row['section_id'] ?? '',
							'tipo'			=> $tipo,
							'model'			=> ''
						],
						"Ignored empty column lang for matrix_time_machine ID $id"
					);
					return;
				}

				// CLI process data status
				if ( running_in_cli()===true ) {
					common::$pdata->msg	= (label::get_label('processing') ?? 'Processing') . ': ' . __METHOD__
						. ' | table: '			. $table
						. ' | id: '				. $id .' - ' . $max
						. ' | section_tipo: '	. $section_tipo
						. ' | section_id: '		. ($row['section_id'] ?? '');
					common::$pdata->memory = (common::$pdata->counter % 5000 === 0)
						? dd_memory_usage()
						: common::$pdata->memory;
					common::$pdata->table = $table;
					common::$pdata->section_tipo = $section_tipo;
					common::$pdata->counter++;
					print_cli(common::$pdata);
				}

				// Empty values: JSON null or [] → SQL NULL (owner decision 2026-10-24). The row
				// asserts no value; v7 reads an absent value as NULL, never as a JSON literal.
				// Rows already SQL NULL ($row['data'] === null) are left alone.
				if (v6_to_v7::is_empty_tm_value($row['data'] ?? null, $data)) {
					if ($save) {
						if (!isset($ar_escaped_tables[$table])) {
							$ar_escaped_tables[$table] = pg_escape_identifier($conn, $table);
						}
						$result = matrix_db_manager::exec_search(
							'UPDATE ' . $ar_escaped_tables[$table] . ' SET data = NULL WHERE id = $1',
							[$id],
							false
						);
						if ($result === false) {
							$response->errors[] = "Error on SQL execution for ID $id. Table: $table";
							return;
						}
					}
					v6_to_v7_normalize::add(
						$response,
						'TM_EMPTY_VALUE_TO_NULL',
						v6_to_v7_normalize::SEVERITY_FIXED,
						[
							'table'			=> $table,
							'section_tipo'	=> $section_tipo,
							'section_id'	=> $row['section_id'] ?? '',
							'tipo'			=> $tipo,
							'model'			=> ''
						],
						'Time-machine value JSON null / [] written as SQL NULL (no value).'
					);
					return;
				}

				if(empty($data)) {
					return;
				}

				// safe tipo
				$safe_tipo = safe_tipo($tipo);
				if( empty($safe_tipo) ) {
					v6_to_v7_normalize::add(
						$response,
						'INVALID_TIPO',
						v6_to_v7_normalize::SEVERITY_NOTICE,
						[
							'table'			=> $table,
							'section_tipo'	=> $section_tipo,
							'section_id'	=> $row['section_id'] ?? '',
							'tipo'			=> $tipo,
							'model'			=> ''
						],
						"Ignored empty safe_tipo for matrix_time_machine ID $id. Tipo: $tipo"
					);
					return;
				}

				// Determine record kind: section snapshot vs. component snapshot
				// In the TM table the 'tipo' column holds either the section_tipo (for a
				// whole-section snapshot) or a component tipo (for a single-component change).
				// The two cases need completely different migration paths.
				$is_section = $safe_tipo === $section_tipo;

				if($is_section) {

					// Temporary fix for invalid import rows
					// Some rows imported from external sources wrapped the section snapshot
					// inside an extra data.0 envelope. Unwrap it before migrating.
					$safe_data = $data;
					if(isset($data->data->{'0'})) {
						$safe_data = $data->data->{'0'};
					}

					// section case
					$migrated_data_response = v6_to_v7::migrate_section_data(
						$section_tipo,
						$section_id,
						$safe_data // Normally an array as [{"id":1."label":"xx","relations":[],..}]
					);

				}else{

					// Studio default only: DELETE the row, never migrate or empty it.
					// The v6 client wrote the default map view (39.462571/-0.376295) on save
					// whether or not the operator touched the map, so a TM row whose WHOLE
					// payload is that view records a change that never happened. Migrating
					// it carries the fabrication into v7 history; emptying it to NULL leaves
					// a husk row asserting an empty change. Deleting is the only honest
					// outcome. A row that also carries features — or any real view — is NOT
					// disposable and falls through untouched.
					//
					// Gated on the VALUE SHAPE, not on a resolved model: the predicate
					// demands every item carry lat AND lon equal to the studio pair, which
					// no other component model stores, and matrix_time_machine is the largest
					// table in the database — an ontology lookup per row to learn what the
					// shape already proves would cost the migration dearly.
					if (v6_to_v7_normalize::is_disposable_studio_default_list(array_values((array)$data))) {
						if ($save) {
							tm_db_manager::delete( (int)$id );
						}
						v6_to_v7_normalize::add(
							$response,
							'TM_DEFAULT_ITEM_ROW_DELETED',
							v6_to_v7_normalize::SEVERITY_FIXED,
							[
								'table'			=> $table,
								'section_tipo'	=> $section_tipo,
								'section_id'	=> $row['section_id'] ?? '',
								'tipo'			=> $tipo,
								'model'			=> 'component_geolocation'
							],
							'Time-machine row deleted: its whole payload was the studio default map'
								. ' view the v6 client wrote on save, so it records a change that'
								. ' never happened. Rows carrying features or a real view are kept'
								. ' exactly as stored.'
						);
						return;
					}

					// Stale ontology rows: DELETE. Old ontology-editing history filed under the
					// Ontology section (dd1500) with tipos that today name components of another
					// section; the payload is ontology node JSON that matches no current schema.
					// The real history moved with its node (or the node was test data), so
					// these rows record nothing restorable (owner decision 2026-10-24).
					if (in_array($safe_tipo, v6_to_v7::STALE_ONTOLOGY_TM_TIPOS[$section_tipo] ?? [], true)) {
						if ($save) {
							tm_db_manager::delete( (int)$id );
						}
						v6_to_v7_normalize::add(
							$response,
							'TM_STALE_ONTOLOGY_ROW_DELETED',
							v6_to_v7_normalize::SEVERITY_FIXED,
							[
								'table'			=> $table,
								'section_tipo'	=> $section_tipo,
								'section_id'	=> $row['section_id'] ?? '',
								'tipo'			=> $tipo,
								'model'			=> ''
							],
							'Time-machine row deleted: old ontology data filed under the Ontology'
								. ' section with a tipo that names a component of another section'
								. ' today; it matches no current schema and cannot be restored.'
						);
						return;
					}

					// component case
					$migrated_data_response = v6_to_v7::migrate_component_data(
						$safe_tipo,
						$data,
						$lang,
						$section_tipo,
						$section_id
					);
				}

				// Fold findings in REGARDLESS of the outcome. A section snapshot can produce
				// findings and still migrate, and the group report is the operator-facing
				// verdict: it must not disagree with the run's own error list.
				//
				// Two channels, deliberately handled differently:
				//  · ->findings  come from defer() and have NOT been aggregated yet; merge()
				//                is what counts them and re-applies the severity rule (so a
				//                notice here no longer fails the run).
				//  · ->errors    are what migrate_section_data collected when it passed its
				//                OWN response down into process_matrix_row_data, where add()
				//                already counted them into the groups. Those strings are
				//                carried up verbatim — re-adding them would double-count.
				v6_to_v7_normalize::merge($response, $migrated_data_response, $table);
				if (!empty($migrated_data_response->errors)) {
					$response->errors[] = "matrix_time_machine ID $id";
					$response->errors = array_merge($response->errors, $migrated_data_response->errors);
				}

				// Row deletion asked by migrate_component_data (v4 text value that exists in
				// no target record — owner decision 2026-10-24). Findings already merged.
				if (($migrated_data_response->delete_row ?? false) === true) {
					if ($save) {
						tm_db_manager::delete( (int)$id );
					}
					return;
				}

				// data migrate to v7
				if( $migrated_data_response->result === false ) {
					return;
				}

				// Skip unchanged rows
				// JSON round-trip comparison is used here instead of PHP strict equality
				// because $data may contain stdClass objects that PHP would compare as
				// equal even when their JSON representations differ (numeric vs. string keys,
				// etc.). Serialising both sides ensures a consistent comparison.
				if(json_handler::encode($migrated_data_response->result) === json_handler::encode($data)) {
					return;
				}

				$data_json = (empty($migrated_data_response->result))
					? null
					: json_handler::encode($migrated_data_response->result, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);

				$params = [
					$data_json,
					$id
				];

				if (!isset($ar_escaped_tables[$table])) {
					$ar_escaped_tables[$table] = pg_escape_identifier($conn, $table);
				}
				$escaped_table = $ar_escaped_tables[$table];

				$strQuery = 'UPDATE ' . $escaped_table . ' SET data = $1 WHERE id = $2';

				if ($save) {
					$result = matrix_db_manager::exec_search($strQuery, $params, false);
				} else {
					// Debug
					debug_log(__METHOD__
						. ' Time machine re format data: ID ' . $id . PHP_EOL
						. ' data: ' . json_handler::encode($data, JSON_PRETTY_PRINT) . PHP_EOL
						. ' final_data: ' . json_handler::encode($migrated_data_response->result, JSON_PRETTY_PRINT)
					    , logger::DEBUG
					);

					$result = true;
				}

				if($result===false) {
					$msg = "Failed Update section_data ($table) $id";
					debug_log(__METHOD__
						." ERROR: $msg "
						, logger::ERROR
					);
					$response->errors[] = "Error on SQL execution for ID $id. Table: $table";
					return; // Return from closure
				}

			}//end function
		);

		$response->result	= empty($response->errors);
		$response->msg		= empty($response->errors)
			? 'Request done successfully'
			: 'Request done with errors (' . count($response->errors) . ')';

		return $response;
	}//end reformat_matrix_time_machine_data



	/**
	 * V5 BARE-ID RELATION COMPONENTS
	 * Relation components whose v5 time-machine rows store the target's section_id as a
	 * bare number (e.g. dd1725 → 5) instead of a locator array. Those rows were never
	 * converted to v6 (live data was; history was not), and v7 reads locators only.
	 * Each entry names the component's ONE target section and its relation type, so the
	 * conversion is exact, never inferred.
	 */
	public const STALE_ONTOLOGY_TM_TIPOS = [
		// Ontology section → component tipos whose TM rows there are old ontology node
		// JSON (2021-02..2024-09), not data of any current component of dd1500:
		// dd1475 (bibliographic reference portal, parent dd1476) and its dataframes
		// dd1477 / dd1483; dd1556, a former test node now used in another section.
		'dd1500' => ['dd1475', 'dd1477', 'dd1483', 'dd1556']
	];



	public const V5_BARE_ID_COMPONENTS = [
		// Users: Profile (component_select → Profiles)
		'dd1725' => ['section_tipo' => 'dd234', 'type' => 'dd151']
	];



	/**
	 * LEGACY_BARE_ID_TO_LOCATORS
	 * Converts a v5 bare id (int or digit string) of a V5_BARE_ID_COMPONENTS tipo into the
	 * locator array v6 writes:
	 * 	5 → [{"type":"dd151","section_id":"5","section_tipo":"dd234","from_component_tipo":"dd1725"}]
	 * @param string $tipo
	 * @param mixed $raw_value
	 * @return array|null The locator array, or null when the tipo is not listed or the value
	 * 	is not a bare id (locator arrays and everything else are left to their own paths).
	 */
	public static function legacy_bare_id_to_locators( string $tipo, mixed $raw_value ) : ?array {

		$target = v6_to_v7::V5_BARE_ID_COMPONENTS[$tipo] ?? null;
		if ($target === null) {
			return null;
		}

		$is_bare_id = (is_int($raw_value) && $raw_value > 0)
			|| (is_string($raw_value) && preg_match('/^[1-9][0-9]*$/', $raw_value) === 1);
		if (!$is_bare_id) {
			return null;
		}

		$locator = new stdClass();
			$locator->type					= $target['type'];
			$locator->section_id			= (string)$raw_value;
			$locator->section_tipo			= $target['section_tipo'];
			$locator->from_component_tipo	= $tipo;

		return [$locator];
	}//end legacy_bare_id_to_locators



	/**
	 * V4_FILTER_OBJECT_TO_LOCATORS
	 * Converts a pre-4.9.0 component_filter value — an OBJECT keyed by project section_id
	 * ({"1": 2, "7": 1}; the values are unused permission levels) — into its filter
	 * locators through component_filter::convert_dato_pre_490, the component's own rule
	 * (keys <= 0 are discarded there). Time-machine rows kept this shape after v6
	 * converted the live data (owner decision 2026-10-24: the upgrade converts it).
	 * An object with no valid key ({"0":"1"}) converts to [] and the row is written
	 * as data = NULL, as v6 did to the same value in live data (owner decision).
	 * @param string $model
	 * @param string $tipo
	 * @param mixed $raw_value
	 * @return array|null The locator array, or null when the model is not component_filter
	 * 	or the value is not a v4 project object (a locator array keeps its own path).
	 */
	public static function v4_filter_object_to_locators( string $model, string $tipo, mixed $raw_value ) : ?array {

		if ($model !== 'component_filter' || !is_object($raw_value)) {
			return null;
		}

		$entries = get_object_vars($raw_value);
		if (empty($entries)) {
			return null;
		}
		foreach ($entries as $key => $value) {
			if (preg_match('/^-?[0-9]+$/', (string)$key) !== 1 || !is_scalar($value)) {
				return null;
			}
		}

		$locators = component_filter::convert_dato_pre_490($raw_value, $tipo);

		return is_array($locators) ? array_values($locators) : null;
	}//end v4_filter_object_to_locators



	/**
	 * V4_TEXT_LABEL_VALUES
	 * Recognises a v4 TEXT value stored in a relation component's time-machine row: the
	 * label of the target record instead of its locator — an array of strings
	 * (["Hispania"], ["Plomo"]) or a bare string ("sks"). v4 components stored the
	 * displayed text; v6 converted the live data to locators but never this history.
	 * @param mixed $raw_value
	 * @return object|null {labels: string[], mixed: bool} — mixed = the array holds strings
	 * 	AND non-strings (untouchable, reported). null when the value holds no string at all
	 * 	(locator arrays, v4 filter objects, bare ids keep their own paths).
	 */
	public static function v4_text_label_values( mixed $raw_value ) : ?object {

		if (is_string($raw_value)) {
			return (object)['labels' => [$raw_value], 'mixed' => false];
		}
		if (!is_array($raw_value) || empty($raw_value)) {
			return null;
		}

		$labels = [];
		$others = 0;
		foreach ($raw_value as $item) {
			if (is_string($item)) {
				$labels[] = $item;
			}else{
				$others++;
			}
		}
		if (empty($labels)) {
			return null;
		}

		return (object)['labels' => $labels, 'mixed' => $others > 0];
	}//end v4_text_label_values



	/**
	 * GET_V4_LABEL_TARGETS
	 * Resolves, from the ontology, WHERE a relation component's labels live: its target
	 * section(s) and, for each, the text component(s) that ARE the record's label — the
	 * same pair the component itself shows:
	 * 	· v6 config: properties.source.request_config[*] → sqo.section_tipo items with
	 * 	  source 'section' (targets) + show.ddo_map items with parent 'self' (labels;
	 * 	  section_tipo 'self' = every target of that config, else the named one(s)).
	 * 	· v5 config (no request_config): the node's relations — model 'section' nodes are
	 * 	  the targets, the other nodes their label components (numisdata10 →
	 * 	  numisdata712 / numisdata87).
	 * Only components stored in the v7 `string` column (DEDALO_VALUE_TYPE_STRING models)
	 * can hold a text label, so only those are kept; a relation label (a dataframe whose
	 * label is a rating radio button) yields a target with no label component.
	 * @param string $tipo
	 * @return array|null [ section_tipo => label_tipo[] ], or null when no target section
	 * 	resolves (unknown sqo source, no config): the value cannot be searched at all.
	 */
	public static function get_v4_label_targets( string $tipo ) : ?array {

		static $cache = [];
		if (array_key_exists($tipo, $cache)) {
			return $cache[$tipo];
		}

		$value_type_map	= v6_to_v7::get_value_type_map();
		$is_text_label	= function(string $label_tipo) use ($value_type_map) : bool {
			$label_model = ontology_node::get_model_by_tipo($label_tipo);
			return !empty($label_model)
				&& ($value_type_map->{$label_model} ?? null) === DEDALO_VALUE_TYPE_STRING;
		};

		$targets		= [];
		$unresolvable	= false;
		$properties		= ontology_node::get_instance($tipo)->get_properties();
		$request_config	= $properties->source->request_config ?? null;

		if (is_array($request_config) && !empty($request_config)) {

			// v6 config
			foreach ($request_config as $config_item) {
				$config_sections = [];
				foreach ((array)($config_item->sqo->section_tipo ?? []) as $sqo_item) {
					if (!is_object($sqo_item) || ($sqo_item->source ?? null) !== 'section') {
						// hierarchy_types, field_value, …: resolved at runtime from data,
						// never an exact ontology answer. Refuse rather than guess.
						$unresolvable = true;
						continue;
					}
					foreach ((array)($sqo_item->value ?? []) as $section_tipo) {
						if (is_string($section_tipo) && safe_tipo($section_tipo)) {
							$config_sections[] = $section_tipo;
							$targets[$section_tipo] = $targets[$section_tipo] ?? [];
						}
					}
				}
				foreach ((array)($config_item->show->ddo_map ?? []) as $ddo) {
					$label_tipo = $ddo->tipo ?? null;
					if (!is_object($ddo) || ($ddo->parent ?? null) !== 'self'
						|| !is_string($label_tipo) || !$is_text_label($label_tipo)) {
						continue;
					}
					$ddo_sections = ($ddo->section_tipo ?? 'self') === 'self'
						? $config_sections
						: array_intersect((array)$ddo->section_tipo, $config_sections);
					foreach ($ddo_sections as $section_tipo) {
						if (!in_array($label_tipo, $targets[$section_tipo], true)) {
							$targets[$section_tipo][] = $label_tipo;
						}
					}
				}
			}

		}else{

			// v5 config: the relations name the target section(s) and the label component(s)
			$sections	= [];
			$labels		= [];
			foreach (ontology_node::get_relation_nodes($tipo, false, true) as $related_tipo) {
				$related_model = ontology_node::get_model_by_tipo($related_tipo);
				if ($related_model === 'section') {
					$sections[] = $related_tipo;
				}elseif ($is_text_label($related_tipo)) {
					$labels[] = $related_tipo;
				}
			}
			foreach ($sections as $section_tipo) {
				$targets[$section_tipo] = $labels;
			}
		}

		$cache[$tipo] = ($unresolvable || empty($targets)) ? null : $targets;

		return $cache[$tipo];
	}//end get_v4_label_targets



	/**
	 * V4_LABEL_HTML_MODELS
	 * Label models whose stored value is HTML: matched on their text content.
	 * (component_input_text_large / component_html_text resolve to component_text_area.)
	 */
	public const V4_LABEL_HTML_MODELS = ['component_text_area'];



	/**
	 * LABEL_TEXT_CONTENT
	 * The text content of an HTML label: tags stripped, entities decoded, whitespace
	 * (NBSP included) collapsed and trimmed. "<p>bolś<span></span>kan&nbsp;</p>" → "bolśkan".
	 * @param string $value
	 * @return string
	 */
	public static function label_text_content( string $value ) : string {

		$text = html_entity_decode(strip_tags($value), ENT_QUOTES | ENT_HTML5, 'UTF-8');
		$text = preg_replace('/[\s\x{00A0}]+/u', ' ', $text) ?? $text;

		return trim($text);
	}//end label_text_content



	/**
	 * GET_HTML_LABEL_INDEX
	 * Text-content index of one HTML label tipo in one section: text => [section_id => lang[]].
	 * Read once per (section, label tipo) and kept for the pass; empty texts are not indexed.
	 * @param string $table
	 * @param string $section_tipo
	 * @param string $label_tipo
	 * @return array|null null when the query fails
	 */
	public static function get_html_label_index( string $table, string $section_tipo, string $label_tipo ) : ?array {

		static $indexes = [];
		$key = $section_tipo . '|' . $label_tipo;
		if (array_key_exists($key, $indexes)) {
			return $indexes[$key];
		}

		$sql = 'SELECT section_id, string->$2 AS items FROM "' . $table . '"'
			. ' WHERE section_tipo = $1 AND string ? $2';
		$result = matrix_db_manager::exec_search($sql, [$section_tipo, $label_tipo]);
		if ($result === false) {
			return $indexes[$key] = null;
		}

		$index = [];
		while ($row = pg_fetch_assoc($result)) {
			foreach ((array)json_decode((string)$row['items']) as $item) {
				if (!is_object($item) || !is_string($item->value ?? null)) {
					continue;
				}
				$text = v6_to_v7::label_text_content($item->value);
				if ($text === '') {
					continue;
				}
				$index[$text][(string)$row['section_id']][] = (string)($item->lang ?? '');
			}
		}

		return $indexes[$key] = $index;
	}//end get_html_label_index



	/**
	 * FIND_LABEL_RECORDS
	 * Records of $section_tipo whose $label_tipo holds EXACTLY $label (string equality,
	 * any lang), read from the v7 `string` column: the TM pass runs after
	 * reformat_matrix_data, so the live tables are already in v7 form there
	 * ({tipo: [{id, lang, value}]}). Cached per (section, label tipo, label): one label
	 * repeats across many history rows.
	 * @param string $section_tipo
	 * @param string $label_tipo
	 * @param string $label
	 * @return array|null [ section_id => lang[] ] (the langs whose value matched), or null
	 * 	when the table cannot be resolved or the query fails.
	 */
	public static function find_label_records( string $section_tipo, string $label_tipo, string $label ) : ?array {

		static $cache = [];
		$key = $section_tipo . '|' . $label_tipo . '|' . $label;
		if (array_key_exists($key, $cache)) {
			return $cache[$key];
		}
		if (count($cache) >= 50000) {
			$cache = [];
		}

		$table = common::get_matrix_table_from_tipo($section_tipo);
		if (empty($table) || preg_match('/^[a-z_]+$/', $table) !== 1) {
			return $cache[$key] = null;
		}

		// HTML label (text_area): the TEXT CONTENT is compared, tags are irrelevant
		// (owner decision 2026-10-24) — the stored "<p>baŕśkunes</p>" is the label
		// "baŕśkunes". No SQL containment can see through markup, so the section's
		// values of that label tipo are read ONCE and indexed by their text content.
		if (in_array(ontology_node::get_model_by_tipo($label_tipo), v6_to_v7::V4_LABEL_HTML_MODELS, true)) {
			$index = v6_to_v7::get_html_label_index($table, $section_tipo, $label_tipo);
			if ($index === null) {
				return $cache[$key] = null;
			}
			return $cache[$key] = ($index[v6_to_v7::label_text_content($label)] ?? []);
		}

		// containment on the GIN-indexed column; exact on a JSON string scalar
		$needle = json_encode(
			[$label_tipo => [['value' => $label]]],
			JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES
		);
		$sql = 'SELECT section_id, string->$2 AS items FROM "' . $table . '"'
			. ' WHERE section_tipo = $1 AND string @> $3::jsonb';
		$result = matrix_db_manager::exec_search($sql, [$section_tipo, $label_tipo, $needle]);
		if ($result === false) {
			return $cache[$key] = null;
		}

		$records = [];
		while ($row = pg_fetch_assoc($result)) {
			$langs = [];
			foreach ((array)json_decode((string)$row['items']) as $item) {
				if (is_object($item) && ($item->value ?? null) === $label) {
					$langs[] = (string)($item->lang ?? '');
				}
			}
			if (!empty($langs)) {
				$records[(string)$row['section_id']] = $langs;
			}
		}

		return $cache[$key] = $records;
	}//end find_label_records



	/**
	 * V4_TEXT_LABELS_TO_LOCATORS
	 * Converts a v4 TEXT value of a relation component's TM row (V4_TEXT_LABEL_VALUES)
	 * into locators by finding, EXACTLY, the target record whose label equals each string
	 * (owner decision 2026-10-24). Verdicts:
	 * 	· convert   — every label names exactly ONE target record → its locator
	 * 	              {type, section_id (string), section_tipo, from_component_tipo}.
	 * 	· delete    — an empty label ("" / [""]: no value), or ANY label exists in no
	 * 	              target record: the row records a value that does not exist (slop of
	 * 	              re-used v4 nodes). The caller deletes the TM row.
	 * 	· ambiguous — a label names MORE than one record: never guessed, row untouched.
	 * 	· mixed / unresolvable / unpaired — untouched: strings beside non-strings; no
	 * 	              exact target or relation type in the ontology; a dataframe value
	 * 	              that WOULD resolve but cannot be paired with its main item.
	 * Lang: a label matches in the row's lang first, then lg-nolan, then any lang — the
	 * first tier with a match decides (relation rows were filed as lg-nolan by v6, so
	 * the row lang often says nothing about the text's lang). Exact string equality in
	 * every tier, and a tier with two records is ambiguous, not a pick. An HTML label
	 * (V4_LABEL_HTML_MODELS) is compared on its text content, both sides
	 * (label_text_content): the tags are irrelevant (owner decision 2026-10-24).
	 * @param string $model
	 * @param string $tipo
	 * @param mixed $raw_value
	 * @param string $lang
	 * @return object|null {verdict, locators, detail}, or null when the value is not a v4
	 * 	text value at all.
	 */
	public static function v4_text_labels_to_locators( string $model, string $tipo, mixed $raw_value, string $lang ) : ?object {

		$values = v6_to_v7::v4_text_label_values($raw_value);
		if ($values === null) {
			return null;
		}
		$verdict = function(string $verdict, string $detail, array $locators=[]) : object {
			return (object)['verdict' => $verdict, 'locators' => $locators, 'detail' => $detail];
		};

		if ($values->mixed) {
			return $verdict('mixed', 'strings mixed with non-string items');
		}

		// no value: nothing to look up
		foreach ($values->labels as $label) {
			if (trim($label) === '') {
				return $verdict('delete', 'empty label');
			}
		}

		$targets = v6_to_v7::get_v4_label_targets($tipo);
		if ($targets === null) {
			return $verdict('unresolvable', 'no exact target section in the ontology');
		}
		if (empty(array_filter($targets))) {
			// targets known, but none has a text label component (a dataframe whose
			// target is identified by a rating radio button): no text can name a record
			return $verdict('no_label', 'target section(s) ' . implode(', ', array_keys($targets)) . ' have no text label component');
		}

		$nolan			= defined('DEDALO_DATA_NOLAN') ? DEDALO_DATA_NOLAN : 'lg-nolan';
		$lang_tiers		= ($lang !== $nolan) ? [$lang, $nolan, null] : [$nolan, null];
		$matches		= []; // label => [ "section_tipo|section_id" ]
		foreach (array_unique($values->labels) as $label) {
			// every record holding the label, with its matching langs
			$found = []; // "section_tipo|section_id" => lang[]
			foreach ($targets as $section_tipo => $label_tipos) {
				foreach ($label_tipos as $label_tipo) {
					$records = v6_to_v7::find_label_records($section_tipo, $label_tipo, $label);
					if ($records === null) {
						return $verdict('unresolvable', "label lookup failed in '$section_tipo'");
					}
					foreach ($records as $section_id => $langs) {
						$record_key = $section_tipo . '|' . $section_id;
						$found[$record_key] = array_merge($found[$record_key] ?? [], $langs);
					}
				}
			}
			if (empty($found)) {
				return $verdict('delete', "label '$label' exists in no target record");
			}
			foreach ($lang_tiers as $tier_lang) {
				$tier = array_keys(array_filter($found, function($langs) use ($tier_lang) {
					return $tier_lang === null || in_array($tier_lang, $langs, true);
				}));
				if (!empty($tier)) {
					break;
				}
			}
			if (count($tier) > 1) {
				return $verdict('ambiguous', "label '$label' names " . count($tier) . ' records: ' . implode(', ', $tier));
			}
			$matches[$label] = $tier[0];
		}

		if ($model === 'component_dataframe') {
			// a frame locator is paired to a main item (id_key) that a v4 text cannot name
			return $verdict('unpaired', 'dataframe value resolves but cannot be paired with its main item');
		}

		$properties		= ontology_node::get_instance($tipo)->get_properties();
		$relation_type	= $properties->config_relation->relation_type ?? null;
		if (empty($relation_type) && class_exists($model)) {
			$relation_type = (new ReflectionClass($model))->getDefaultProperties()['default_relation_type'] ?? null;
		}
		if (empty($relation_type)) {
			return $verdict('unresolvable', "no relation type for model '$model'");
		}

		$locators	= [];
		$seen		= [];
		foreach ($values->labels as $label) {
			$record_key = $matches[$label];
			if (isset($seen[$record_key])) {
				continue;
			}
			$seen[$record_key] = true;
			[$section_tipo, $section_id] = explode('|', $record_key, 2);
			$locator = new stdClass();
				$locator->type					= $relation_type;
				$locator->section_id			= (string)$section_id;
				$locator->section_tipo			= $section_tipo;
				$locator->from_component_tipo	= $tipo;
			$locators[] = $locator;
		}

		return $verdict('convert', 'labels resolved', $locators);
	}//end v4_text_labels_to_locators



	/**
	 * TEST_TLD
	 * The `test` TLD names the development fixtures of the Dédalo test suite; no
	 * installation's history may carry rows of it (owner decision 2026-10-24: the TM pass
	 * deletes them, component and section rows alike).
	 */
	public const TEST_TLD = 'test';



	/**
	 * IS_TEST_TLD_TM_ROW
	 * True when the TM row's tipo OR section_tipo belongs to the TEST_TLD (test99963,
	 * test71). Only well-formed tipos are asked for their TLD.
	 * @param mixed $tipo
	 * @param mixed $section_tipo
	 * @return bool
	 */
	public static function is_test_tld_tm_row( mixed $tipo, mixed $section_tipo ) : bool {

		foreach ([$tipo, $section_tipo] as $candidate) {
			if (safe_tipo($candidate) && get_tld_from_tipo($candidate) === v6_to_v7::TEST_TLD) {
				return true;
			}
		}

		return false;
	}//end is_test_tld_tm_row



	/**
	 * IS_EMPTY_TM_VALUE
	 * True when the decoded TM payload is JSON null or an empty array: a row asserting no
	 * value, written as SQL NULL by the TM pass (owner decision 2026-10-24). A column that
	 * is already SQL NULL is NOT empty-valued here — it needs no write.
	 * @param mixed $raw_column - the column as read (null = SQL NULL)
	 * @param mixed $decoded - json_decode of it
	 * @return bool
	 */
	public static function is_empty_tm_value( mixed $raw_column, mixed $decoded ) : bool {

		if ($raw_column === null) {
			return false;
		}

		return $decoded === null || $decoded === [];
	}//end is_empty_tm_value



	/**
	 * SPLIT_NONSENSE_LOCATORS
	 * Separates, in a relation component's TM value, the entries that are objects but NOT
	 * locators — no section_tipo and/or no section_id (a v6 error artifact
	 * {"type":"dd151","scalar":"Error: target component_filter is not de…"}, a husk
	 * {"type":"dd151","from_component_tipo":"numisdata261"}) — from the real locators
	 * (owner decision 2026-10-24). Non-object entries are not judged here (text labels,
	 * bare ids keep their own paths). An empty section_id ("") counts as no section_id.
	 * A target-less entry carrying a `ds` payload ({"ds":[{…rolepos1…}],"section_id":"",…})
	 * is a previous dataframe never converted, and wrong: nonsense too (owner decision
	 * 2026-10-24). It is dropped like the rest and ALSO listed in `semantic`, so the
	 * caller can name the case.
	 * @param mixed $raw_value
	 * @return object|null {valid: array, dropped: array, semantic: array}, or null when the
	 * 	value is not an array of objects holding at least one target-less entry.
	 */
	public static function split_nonsense_locators( mixed $raw_value ) : ?object {

		if (!is_array($raw_value) || empty($raw_value)) {
			return null;
		}

		$valid		= [];
		$dropped	= [];
		$semantic	= [];
		foreach ($raw_value as $item) {
			if (!is_object($item)) {
				return null;
			}
			$has_section_tipo	= isset($item->section_tipo) && is_string($item->section_tipo) && $item->section_tipo !== '';
			$has_section_id		= isset($item->section_id) && (is_int($item->section_id)
				|| (is_string($item->section_id) && $item->section_id !== ''));
			if ($has_section_tipo && $has_section_id) {
				$valid[] = $item;
			}else{
				$dropped[] = $item;
				if (!empty($item->ds)) {
					$semantic[] = $item;
				}
			}
		}

		return empty($dropped)
			? null
			: (object)['valid' => $valid, 'dropped' => $dropped, 'semantic' => $semantic];
	}//end split_nonsense_locators



	/**
	 * MIGRATE_COMPONENT_DATA
	 *
	 * Migrates component data from v6 format to v7 format.
	 * Handles normalization of non-array values, typology mapping, language-aware strings,
	 * and specialized formatting for complex types (Date, Media, Geo, IRI).
	 *
	 * (!) It is used ONLY in TIME MACHINE transformations (matrix_time_machine table) to avoid change
	 * the actual process_matrix_row_data method.
	 *
	 * @param string $tipo The component type (e.g., 'dd12').
	 * @param mixed $raw_value The raw data to migrate. Can be a single value or an array of values.
	 * @param string $lang The language code (e.g., 'lg-eng').
	 * @param string|null $section_tipo The section type (e.g., 'oh1').
	 * @param mixed $section_id The section id (e.g., 123).
	 * @param int $value_key The key of the value to migrate. Defaults to 0.
	 * @param string|null $model Pre-resolved model name to skip redundant ontology lookups.
	 * @param string|null $stored_model Model name recorded in the row itself when the value was
	 *                    written (info.modelo / inf). Purely diagnostic: when it disagrees with
	 *                    $model, the ontology changed under the data, and that is the fact the
	 *                    operator needs in the report.
	 * @return stdClass Response object with 'errors' (array), 'findings' (array) and
	 *                  'result' (array|false). 'result' contains the migrated data array,
	 *                  or false if no changes were needed.
	 */
	public static function migrate_component_data(
			string $tipo,
			mixed $raw_value, // each lang value
			string $lang,
			?string $section_tipo = null,
			mixed $section_id = null,
			int $value_key = 0,
			?string $model = null,
			?string $stored_model = null
		) : stdClass {

		$response = new stdClass();
		$response->errors	= [];
		$response->findings	= [];

		// context carried by every finding this call may produce. The table is unknown here
		// (this runs one level below the row iterator); v6_to_v7_normalize::merge() stamps it.
		$ctx = [
			'section_tipo'	=> $section_tipo,
			'section_id'	=> $section_id,
			'tipo'			=> $tipo,
			'model'			=> $model,
			'stored_model'	=> $stored_model
		];

		// safe tipo. Check if the tipo is valid
		$safe_tipo = safe_tipo($tipo);
		if( empty($safe_tipo) ) {
			// Not a well-formed tipo at all: nothing can be resolved from it and the value
			// is dropped. Nothing to repair, so this is a notice, not a failure.
			v6_to_v7_normalize::defer(
				$response,
				'INVALID_TIPO',
				v6_to_v7_normalize::SEVERITY_NOTICE,
				$ctx,
				"Ignored empty safe_tipo. Tipo: $tipo"
			);
			$response->result = false;
			return $response;
		}

		// Use provided model or resolve from ontology
		if( empty($model) ) {
			$model = ontology_node::get_model_by_tipo($tipo);
			$ctx['model'] = $model;
		}
		if( empty($model) ) {
			// Orphan tipo: referenced by matrix data but absent from the ontology (jer_dd),
			// so no model resolves and the value cannot be typed into a v7 column. There is
			// no transformation that would fix this — the value is dropped, and the operator
			// is told which tipo, where it lives, and what it used to be.
			v6_to_v7_normalize::defer(
				$response,
				'ORPHAN_TIPO',
				v6_to_v7_normalize::SEVERITY_NOTICE,
				$ctx,
				"Orphan tipo '$tipo' is not in the ontology: no model resolves, so the value is dropped"
					. ($stored_model !== null ? " (written as $stored_model)" : '')
					. ($section_tipo !== null ? " — section_tipo: '$section_tipo'" : ''),
				$raw_value
			);
			$response->result = false;
			return $response;
		}

		// Guard: do not touch relation components
		// Relation data (locators) in the TM table was already migrated by the
		// relations branch of process_matrix_row_data(); re-processing it here would
		// double-wrap the locators and corrupt the data.
		static $components_with_relations = null;
		if ($components_with_relations === null) {
			$components_with_relations = component_relation_common::get_components_with_relations();
		}
		if(in_array($model, $components_with_relations)) {
			// v5 bare ids never converted to v6 locators (owner decision 2026-10-24).
			// A FORMAT migration, not a value repair: the number IS the section_id of the
			// component's one target, so it becomes the locator v6 would have written.
			$legacy_locator = v6_to_v7::legacy_bare_id_to_locators($tipo, $raw_value);
			if ($legacy_locator !== null) {
				v6_to_v7_normalize::defer(
					$response,
					'TM_V5_BARE_ID_TO_LOCATOR',
					v6_to_v7_normalize::SEVERITY_FIXED,
					$ctx,
					"v5 bare id '$raw_value' converted to its locator",
					$raw_value
				);
				$response->result = $legacy_locator;
				return $response;
			}
			// v4 project object (pre-4.9.0 component_filter: {"1": 2}, key = project
			// section_id) → its filter locators, by the component's own historical rule.
			$filter_locators = v6_to_v7::v4_filter_object_to_locators($model, $tipo, $raw_value);
			if ($filter_locators !== null) {
				v6_to_v7_normalize::defer(
					$response,
					'TM_V4_FILTER_OBJECT_TO_LOCATORS',
					v6_to_v7_normalize::SEVERITY_FIXED,
					$ctx,
					'v4 project object converted to filter locators',
					$raw_value
				);
				$response->result = $filter_locators;
				return $response;
			}
			// v4 TEXT value (the target's label: ["Hispania"], "sks") → the locator of the
			// one target record whose label is EXACTLY that text; a value that exists in no
			// target record (or is empty) means the row is deleted (owner decision
			// 2026-10-24: re-used v4 nodes kept slop data). Ambiguous → never guessed.
			// TM PASS ONLY ($history_pass): the lookup reads the target tables' v7 `string`
			// column, complete only after reformat_matrix_data, and a delete verdict means
			// "delete the TM row" — the live literal path (process_matrix_row_data) keeps
			// its old behaviour (relation value skipped).
			$label_response = (v6_to_v7_normalize::$history_pass === true)
				? v6_to_v7::v4_text_labels_to_locators($model, $tipo, $raw_value, $lang)
				: null;
			if ($label_response !== null) {
				$label_sample = (object)['lang' => $lang, 'value' => $raw_value, 'detail' => $label_response->detail];
				switch ($label_response->verdict) {
					case 'convert':
						v6_to_v7_normalize::defer(
							$response,
							'TM_V4_TEXT_LABEL_TO_LOCATOR',
							v6_to_v7_normalize::SEVERITY_FIXED,
							$ctx,
							'v4 text label converted to the locator of the target record holding exactly that label',
							$label_sample
						);
						$response->result = $label_response->locators;
						return $response;

					case 'delete':
					case 'no_label':
						v6_to_v7_normalize::defer(
							$response,
							$label_response->verdict === 'delete'
								? 'TM_V4_TEXT_LABEL_UNMATCHED_ROW_DELETED'
								: 'TM_V4_TEXT_LABEL_NO_TARGET_LABEL_ROW_DELETED',
							v6_to_v7_normalize::SEVERITY_FIXED,
							$ctx,
							$label_response->verdict === 'delete'
								? 'Time-machine row deleted: its v4 text value is empty or exists as the'
									. ' label of no record of the component\'s target section(s)'
								: 'Time-machine row deleted: its v4 text value cannot name a record of the'
									. ' target section(s), which have no text label component',
							$label_sample
						);
						$response->result		= false;
						$response->delete_row	= true;
						return $response;

					default:
						// ambiguous | mixed | unresolvable | unpaired: left exactly as stored.
						// ERROR = needs a human decision: v7 cannot read a text value as a
						// relation, and guessing a record would falsify the history.
						v6_to_v7_normalize::defer(
							$response,
							'TM_V4_TEXT_LABEL_' . strtoupper($label_response->verdict),
							v6_to_v7_normalize::SEVERITY_ERROR,
							$ctx,
							'v4 text value of a relation component left untouched ('
								. $label_response->verdict . '): ' . $label_response->detail,
							$label_sample
						);
						$response->result = false;
						return $response;
				}
			}
			// Objects that are not locators (no section_tipo and/or section_id): v6 error
			// artifacts and husks (owner decision 2026-10-24). All nonsense → the row is
			// deleted; mixed with real locators → the nonsense is dropped, the locators kept.
			// TM pass only, like the text labels: the live relations have their own path.
			$nonsense = (v6_to_v7_normalize::$history_pass === true)
				? v6_to_v7::split_nonsense_locators($raw_value)
				: null;
			if ($nonsense !== null) {
				if (empty($nonsense->valid)) {
					// target-less ds entries: a previous dataframe never converted, and wrong
					// (owner decision 2026-10-24) — deleted, named by its own code.
					$has_ds = !empty($nonsense->semantic);
					v6_to_v7_normalize::defer(
						$response,
						$has_ds ? 'TM_NONSENSE_DS_LOCATOR_ROW_DELETED' : 'TM_NONSENSE_LOCATOR_ROW_DELETED',
						v6_to_v7_normalize::SEVERITY_FIXED,
						$ctx,
						$has_ds
							? 'Time-machine row deleted: target-less ds entries (no section_tipo and/or'
								. ' section_id) of a previous dataframe never converted to v6'
							: 'Time-machine row deleted: every entry is an object that is not a locator'
								. ' (no section_tipo and/or section_id), e.g. a v6 error artifact',
						$raw_value
					);
					$response->result		= false;
					$response->delete_row	= true;
					return $response;
				}
				v6_to_v7_normalize::defer(
					$response,
					'TM_NONSENSE_LOCATOR_ENTRIES_DROPPED',
					v6_to_v7_normalize::SEVERITY_FIXED,
					$ctx,
					'Time-machine value: entries that are not locators (no section_tipo and/or'
						. ' section_id, ds-only included) dropped; the valid locators are kept as stored',
					$nonsense->dropped
				);
				$response->result = $nonsense->valid;
				return $response;
			}
			$response->result = false;
			return $response;
		}

		// Normalize non-array values (TinyMCE, etc.)
		// In v6, TinyMCE-backed components stored their value as a plain string (the HTML)
		// rather than an array. A few known garbage values must be silently discarded:
		//   - hierarchy42 with lang 'lg-nolan': a Space-frame artifact with no real content.
		//   - '<br data-mce-bogus="1">': a TinyMCE cursor placeholder, not real data.
		//   - tipo 'dd23' (component_layout Layout templates): v5-era internal record, dropped in v7.
		if (!is_array($raw_value)) {
			// To delete values
			if (($tipo === 'hierarchy42' && $lang === 'lg-nolan') || // component_text_area Space frame
				($raw_value === '<br data-mce-bogus="1">') ||
				($tipo === 'dd23')) { // component_layout Layout (Layout templates)
				// Blank value, forces to ignore the value
				$ar_value = [];
			}else{
				$ar_value = [$raw_value];
			}
		}else{
			$ar_value = $raw_value;
		}

		// typology
		$value_type_map = v6_to_v7::get_value_type_map();
		$typology = $value_type_map->{$model} ?? DEDALO_VALUE_TYPE_MISC;

		// component_geolocation: remove the old default data, nothing more.
		// The v6 client seeded its edit view with the studio default map view and saved it
		// whether or not the operator touched the map, so opening a record was enough to
		// store a view nobody chose. A default-only item is removed; a default view sitting
		// on real features is refitted to those features. Adjudicated on the WHOLE item list
		// (the verdict depends on its siblings) and IN MEMORY: `datos` is never rewritten.
		// A no-op for every other model. Findings are deferred; the caller merges them.
		$geolocation_repaired = v6_to_v7_normalize::geolocation_value(
			$model,
			array_values((array)$ar_value),
			$ctx,
			$response
		);
		if ($geolocation_repaired !== null) {
			$ar_value = $geolocation_repaired;
		}

		$final_data = [];
		foreach (array_values((array)$ar_value) as $value) {

			// Skip entries with no value
			if (!isset($value) || (empty($value) && $value !== '0')) continue;

			// Skip media components with empty files_info
			if (json_handler::encode($value) === '{"files_info":[]}') continue;

			// Skip old v5 media records pointing to self
			if (is_object($value) && isset($value->component_tipo) && $value->component_tipo === $tipo &&
				isset($value->section_tipo) && $value->section_tipo === $section_tipo &&
				isset($value->section_id) && $value->section_id == $section_id) {
				continue;
			}

			// Dataframe locators ride in a main's composed TM row (v6
			// get_time_machine_data_to_save appends every slot's frames to the main's
			// data). They are relation locators, not items of this model: pass them
			// through as they are — never value-wrapped, never given an id or a lang —
			// so dataframe_v7_migration::migrate_time_machine (transform_entries, which
			// reads top-level entries only) migrates them to dd490 + id_key. Wrapped as
			// {value:{frame},id,lang}, the v7 engine read each one as a text item of the
			// literal and restored it into the literal's column.
			if (is_object($value) && isset($value->main_component_tipo)
				&& (isset($value->from_component_tipo) || isset($value->section_id_key) || isset($value->id_key))) {
				$final_data[] = $value;
				continue;
			}

			$value_key++;

			// Prepare object to store
			if(!is_object($value)) {

				// Check format for complex types (Date, Media, Geo, IRI)
				// This data has a bad format, inform to the user and do not save it
				if (in_array($typology, [DEDALO_VALUE_TYPE_DATE, DEDALO_VALUE_TYPE_MEDIA, DEDALO_VALUE_TYPE_GEO])) {

					$val_str = json_handler::encode($value);
					debug_log(__METHOD__ . " ERROR: component value ($tipo) out of format: $val_str (section_tipo: '$section_tipo' - section_id: '$section_id')", logger::ERROR);
					v6_to_v7_normalize::defer(
						$response,
						'MODEL_DATA_MISMATCH',
						v6_to_v7_normalize::SEVERITY_ERROR,
						$ctx,
						"Bad component data [1] (invalid format. typology: $typology - model: $model). tipo: '$tipo' - section_tipo: '$section_tipo' - section_id: '$section_id'"
							. ($stored_model !== null && $stored_model !== $model
								? " — the ontology says '$model' but the value was written as '$stored_model'"
								: ''),
						$value
					);
					$response->result = false;
					return $response;
				}

				// Build normalized v7 datum object from a scalar value
				if ($typology === DEDALO_VALUE_TYPE_IRI) {

					// IRI scalar normalization
					// In v6, component_iri sometimes stored the full IRI as a plain string,
					// optionally prefixed with a human-readable label (e.g. "My Label http://…").
					// Split on 'http' to separate label from IRI, then reconstruct the v7 shape:
					// { iri: "http://…", title: "My Label" }.
					// Limit to 2 parts so that 'http' within the IRI path is not split again.
					$parts = explode('http', (string)$value, 2);
					$last_part = end($parts);

					$final_obj = (object)[
						'iri' => 'http' . ($last_part ?? '')
					];

					// Add label when $parts > 1
					// $parts[0] is the text before the first 'http'; only include it when non-empty.
					if(count($parts) > 1 && !empty($parts[0])) {
						$final_obj->title = $parts[0];
					}

				}else{

					// Non-IRI scalar: wrap in {value: …} for components that use that property shape.
					// component_common::$components_using_value_property lists the models whose v7
					// datum objects must carry a 'value' property (e.g. component_input_text,
					// component_number, component_date when stored as a scalar — unusual but possible).
					if(in_array($model, component_common::$components_using_value_property)) {

						$final_obj = (object)[
							'value' => $value
						];

					}else{

						$val_str = json_handler::encode($value);
						debug_log(__METHOD__ . " ERROR: component value ($tipo) out of format: $val_str (section_tipo: '$section_tipo' - section_id: '$section_id')", logger::ERROR);
						v6_to_v7_normalize::defer(
							$response,
							'MODEL_DATA_MISMATCH',
							v6_to_v7_normalize::SEVERITY_ERROR,
							$ctx,
							"Bad component data [2]. Expected object. (invalid format. typology: $typology - model: $model). tipo: '$tipo' - section_tipo: '$section_tipo' - section_id: '$section_id'"
								. ($stored_model !== null && $stored_model !== $model
									? " — the ontology says '$model' but the value was written as '$stored_model'"
									: ''),
							$value
						);
						$response->result = false;
						return $response;
					}
				}
			} else {
				// Handle as object
				// This components add a new 'value' property if it is not already present.
				if(in_array($model, component_common::$components_using_value_property) && !isset($value->value)) {

					if(in_array($model, ['component_filter_records','component_info','component_security_access'])) {
						// Only set the missing property as null
						$value->value = null;
						$final_obj = $value;
					}else{
						// Wrap the value in a new object
						$final_obj = (object)[
							'value' => $value
						];
					}
				}else{
					// Other components, such as component_date, component_geolocation, component_av, etc. are already objects. However, they do not use the 'value' property.
					$final_obj = $value;
				}
			}

			// Add property 'id' to the object. ALL components except relations have an 'id' property.
			if(!isset($final_obj->id)) {
				$final_obj->id = $value_key;
			}

			// Special handling for language-aware strings
			if ($typology === DEDALO_VALUE_TYPE_STRING || $typology === DEDALO_VALUE_TYPE_IRI) {
				$final_obj->lang = $lang;
			}


			$final_data[] = $final_obj;
		}//end foreach (array_values((array)$ar_value) as $value)

		$response->result = $final_data;


		return $response;
	}//end migrate_component_data



	/**
	 * MIGRATE_SECTION_DATA
	 *
	 * Migrates section data from v6 format to v7 format.
	 * Handles normalization of non-array values, typology mapping, language-aware strings,
	 * and specialized formatting for complex types (Date, Media, Geo, IRI).
	 *
	 * (!) It is used ONLY in TIME MACHINE transformations (matrix_time_machine table) to avoid change
	 * the actual process_matrix_row_data method.
	 *
	 * @param string $section_tipo The section type (e.g., 'oh1').
	 * @param mixed $section_id The section id (e.g., 123).
	 * @param array|object $section_data The raw data to migrate.
	 * @return stdClass Response object with 'errors' (array) and 'result' (array|false).
	 *                  'result' contains the migrated data array or false if no changes were needed.
	 */
	public static function migrate_section_data(
		string $section_tipo,
		mixed $section_id,
		array|object $section_data
	) : object {

		$response = new stdClass();
			$response->errors	= [];
			$response->findings	= [];
			$response->result	= false;

		// context carried by every finding this call may produce (see migrate_component_data)
		$ctx = [
			'section_tipo'	=> $section_tipo,
			'section_id'	=> $section_id,
			'tipo'			=> $section_tipo,
			'model'			=> null
		];

		// safe tipo. Check if the tipo is valid
		$safe_tipo = safe_tipo($section_tipo);
		if( empty($safe_tipo) ) {
			v6_to_v7_normalize::defer(
				$response,
				'INVALID_TIPO',
				v6_to_v7_normalize::SEVERITY_NOTICE,
				$ctx,
				"Ignored empty safe_tipo. Tipo: $section_tipo"
			);
			$response->result = false;
			return $response;
		}

		// model check
		$model = ontology_node::get_model_by_tipo($section_tipo);
		$ctx['model'] = $model;
		if( empty($model) ) {
			v6_to_v7_normalize::defer(
				$response,
				'ORPHAN_TIPO',
				v6_to_v7_normalize::SEVERITY_NOTICE,
				$ctx,
				"Orphan section tipo '$section_tipo' is not in the ontology: no model resolves, so the snapshot is dropped"
			);
			$response->result = false;
			return $response;
		}
		if($model!=='section'){
			// The TM row claims to be a whole-section snapshot but its tipo resolves to a
			// component model. Nothing to repair; the snapshot cannot be migrated.
			v6_to_v7_normalize::defer(
				$response,
				'NOT_A_SECTION_TIPO',
				v6_to_v7_normalize::SEVERITY_NOTICE,
				$ctx,
				"Ignored non section model ($model). Tipo: $section_tipo"
			);
			$response->result = false;
			return $response;
		}

		$value_type_map = self::get_value_type_map();

		// Unwrap optional array envelope
		// Section snapshots in the TM table were historically stored as a single-element
		// array [{ … section data … }]. Unwrap it so process_matrix_row_data() receives
		// a plain object, which is what it expects.
		$section_data_object = (is_array($section_data) && !empty($section_data)) ? $section_data[0] : $section_data;

		$result = self::process_matrix_row_data(
			$section_data_object,
			'matrix_time_machine',
			$section_tipo,
			$section_id,
			$value_type_map,
			$response
		);

		$response->result = $result;


		return $response;
	}//end migrate_section_data



	/**
	 * DELETE_V6_DB_INDEXES
	 *
	 * Removes existing database indexes and user-defined functions to prepare for v7 schema updates.
	 * Preserves unique indexes that are not explicitly listed for deletion.
	 *
	 * @return bool True if all indexes and functions were successfully processed, false otherwise.
	 */
	public static function delete_v6_db_indexes() : bool {

		$all_indexes = DBi::get_indexes();
		$conn = DBi::_getConnection();

		if (!$all_indexes || !$conn) {
			return false;
		}

		$unique_indexes_to_delete = [
			'matrix_section_id_section_tipo',
			'matrix_activities_section_id_section_tipo',
			'matrix_activity_section_id_section_tipo',
			'matrix_counter_tipo_unique',
			'matrix_counter_dd_tipo_unique',
			'matrix_dataframe_section_id_section_tipo_key',
			'matrix_dd_section_id_section_tipo',
			'matrix_hierarchy_section_id_section_tipo_key',
			'matrix_hierarchy_main_section_id_section_tipo_key',
			'matrix_indexations_section_id_section_tipo_key',
			'matrix_langs_section_id_section_tipo_key',
			'matrix_layout_section_id_section_tipo',
			'matrix_layout_dd_section_id_section_tipo',
			'matrix_list_section_id_section_tipo',
			'matrix_nexus_section_id_section_tipo_key',
			'matrix_nexus_main_section_id_section_tipo_key',
			'matrix_notes_section_id_section_tipo_key',
			'matrix_ontology_section_id_section_tipo_key',
			'matrix_ontology_main_section_id_section_tipo_key',
			'matrix_profiles_section_id_section_tipo',
			'matrix_projects_section_id_section_tipo',
			'matrix_stats_section_id_section_tipo_key',
			'matrix_structurations_section_id_section_tipo_key',
			'matrix_test_section_id_section_tipo_key',
			'matrix_tools_section_id_section_tipo_key',
			'matrix_users_section_id_section_tipo'
		];

		foreach ($all_indexes as $index_object) {

			$indexname = $index_object->indexname;

			$to_search		= "create unique index";
			$is_unique		= stripos($index_object->indexdef, $to_search) !== false;
			$is_to_delete	= in_array($indexname, $unique_indexes_to_delete);

			// Preserve unique indexes not in our explicit deletion list
			// Non-listed unique indexes are assumed to belong to constraints created by
			// the application itself (e.g. project-specific custom uniques) and must not
			// be touched. Only the well-known v6 system indexes are dropped.
			if ($is_unique && !$is_to_delete) {
				continue;
			}

			// CLI feedback
			if (running_in_cli()) {
				if (!isset(common::$pdata)) {
					common::$pdata = new stdClass();
				}
				common::$pdata->msg = " Dropping index: $indexname";
				print_cli(common::$pdata);
			}

			// Drop associated constraints before dropping the index
			// In PostgreSQL a UNIQUE or PRIMARY KEY constraint creates a backing index.
			// Dropping the index directly while the constraint exists raises an error.
			// We must drop the constraint first; the backing index is then dropped implicitly,
			// but we issue a DROP INDEX CASCADE as well for any standalone indexes.
			if ($is_to_delete) {
				$constraints = DBi::get_constraint_name_from_index($indexname);
				if (!empty($constraints)) {
					foreach ($constraints as $constraint_item) {
						$escaped_table		= pg_escape_identifier($conn, $constraint_item->table_name);
						$escaped_constraint	= pg_escape_identifier($conn, $constraint_item->constraint_name);

						$sql_query = "ALTER TABLE {$escaped_table} DROP CONSTRAINT IF EXISTS {$escaped_constraint};";
						matrix_db_manager::exec_sql($sql_query);
					}
				}
			}

			$escaped_schema	= pg_escape_identifier($conn, $index_object->schemaname);
			$escaped_index	= pg_escape_identifier($conn, $indexname);

			$sql_query = "DROP INDEX IF EXISTS {$escaped_schema}.{$escaped_index} CASCADE;";
			$result = matrix_db_manager::exec_sql($sql_query);

			if ($result === false) {
				$msg = "Failed to drop index '$indexname' in PostgreSQL!";
				debug_log(__METHOD__
					. " ERROR: $msg " . PHP_EOL
					. " Query: $sql_query "
					, logger::ERROR
				);
				return false;
			}
		}

		$all_functions = DBi::get_functions();
		if ($all_functions === false) {
			return false;
		}

		foreach ($all_functions as $function_object) {
			$func_name = $function_object->functionname;

			// CLI feedback
			if (running_in_cli()) {
				if (!isset(common::$pdata)) {
					common::$pdata = new stdClass();
				}
				common::$pdata->msg = " Dropping function: $func_name";
				print_cli(common::$pdata);
			}

			$escaped_schema	= pg_escape_identifier($conn, $function_object->schemaname);
			$escaped_func	= pg_escape_identifier($conn, $func_name);
			$arguments		= $function_object->arguments;

			$sql_query = "DROP FUNCTION IF EXISTS {$escaped_schema}.{$escaped_func}({$arguments}) CASCADE;";
			$result = matrix_db_manager::exec_sql($sql_query);

			if ($result === false) {
				$msg = "Failed to drop function '$func_name' in PostgreSQL!";
				debug_log(__METHOD__
					. " ERROR: $msg " . PHP_EOL
					. " Query: $sql_query "
					, logger::ERROR
				);
				return false;
			}
		}

		return true;
	}//end delete_v6_db_indexes



	/**
	 * RENAME_CONSTRAINT
	 *
	 * Renames primary key constraints for core matrix tables to ensure consistency with v7 naming conventions.
	 *
	 * @return bool True if all constraints were successfully renamed, false otherwise.
	 */
	public static function rename_constraint() : bool {

		$ar_constraint = [
			'matrix'				=> ['matrix_id', 'matrix_pkey'],
			'matrix_activities'		=> ['matrix_activities_pkey', 'matrix_activities_pkey'],
			'matrix_activity'		=> ['matrix_activity_id_primary', 'matrix_activity_pkey'],
			'matrix_counter'		=> ['matrix_counter_id', 'matrix_counter_pkey'],
			'matrix_counter_dd'		=> ['matrix_counter_dd_id', 'matrix_counter_dd_pkey'],
			'matrix_dataframe'		=> ['matrix_dataframe_pkey', 'matrix_dataframe_pkey'],
			'matrix_dd'				=> ['matrix_dd_id', 'matrix_dd_pkey'],
			'matrix_hierarchy'		=> ['matrix_hierarchy_pkey', 'matrix_hierarchy_pkey'],
			'matrix_hierarchy_main'	=> ['matrix_hierarchy_main_pkey', 'matrix_hierarchy_main_pkey'],
			'matrix_indexations'	=> ['matrix_indexations_pkey', 'matrix_indexations_pkey'],
			'matrix_langs'			=> ['matrix_langs_pkey', 'matrix_langs_pkey'],
			'matrix_layout'			=> ['matrix_layout_pkey', 'matrix_layout_pkey'],
			'matrix_layout_dd'		=> ['matrix_layout_dd_pkey', 'matrix_layout_dd_pkey'],
			'matrix_list'			=> ['matrix_list_pkey', 'matrix_list_pkey'],
			'matrix_nexus'			=> ['matrix_nexus_pkey', 'matrix_nexus_pkey'],
			'matrix_nexus_main'		=> ['matrix_nexus_main_pkey', 'matrix_nexus_main_pkey'],
			'matrix_notes'			=> ['matrix_notes_pkey', 'matrix_notes_pkey'],
			'matrix_notifications'	=> ['matrix_notifications_id', 'matrix_notifications_pkey'],
			'matrix_ontology'		=> ['matrix_ontology_pkey', 'matrix_ontology_pkey'],
			'matrix_ontology_main'	=> ['matrix_ontology_main_pkey', 'matrix_ontology_main_pkey'],
			'matrix_profiles'		=> ['matrix_profiles_pkey', 'matrix_profiles_pkey'],
			'matrix_projects'		=> ['matrix_projects_id', 'matrix_projects_pkey'],
			'matrix_stats'			=> ['matrix_stats_pkey', 'matrix_stats_pkey'],
			'matrix_test'			=> ['matrix_test_pkey', 'matrix_test_pkey'],
			'matrix_time_machine'	=> ['matrix_time_machine_id', 'matrix_time_machine_pkey'],
			'matrix_tools'			=> ['matrix_tools_pkey', 'matrix_tools_pkey'],
			'matrix_updates'		=> ['matrix_updates_id', 'matrix_updates_pkey'],
			'matrix_users'			=> ['matrix_users_pkey', 'matrix_users_pkey'],
		];

		$conn = DBi::_getConnection();

		foreach ($ar_constraint as $matrix_table => $ar_constraint_to_change) {

			$escaped_table	= pg_escape_identifier($conn, $matrix_table);
			$old_constraint	= pg_escape_identifier($conn, $ar_constraint_to_change[0]);
			$new_constraint	= pg_escape_identifier($conn, $ar_constraint_to_change[1]);

			// CLI feedback
			if (running_in_cli()) {
				if (!isset(common::$pdata)) {
					common::$pdata = new stdClass();
				}
				common::$pdata->msg = " Updating constraints for table: $matrix_table";
				print_cli(common::$pdata);
			}

			// Drop both old and new constraint names before re-adding
			// PostgreSQL does not support RENAME CONSTRAINT without first dropping the existing one.
			// Dropping both old and new ensures the operation is idempotent: a previous partial run
			// that added the new constraint will not cause a "constraint already exists" error.
			$sql_query 	= "ALTER TABLE IF EXISTS {$escaped_table} DROP CONSTRAINT IF EXISTS {$old_constraint}, DROP CONSTRAINT IF EXISTS {$new_constraint};";
			$result		= matrix_db_manager::exec_sql($sql_query);

			if($result===false) {
				$msg = "Failed to delete constraint '$old_constraint' on table '$matrix_table'";
				debug_log(__METHOD__
					." ERROR: $msg " . PHP_EOL
					." Query: $sql_query "
					, logger::ERROR
				);
				return false;
			}

			// Add primary key
			if (DBi::check_column_exists($matrix_table, 'id')) {
				$sql_query 	= "ALTER TABLE IF EXISTS {$escaped_table} ADD CONSTRAINT {$new_constraint} PRIMARY KEY (id);";
				$result		= matrix_db_manager::exec_sql($sql_query);

				if($result===false) {
					$msg = "Failed to add primary key constraint '$new_constraint' on table '$matrix_table'";
					debug_log(__METHOD__
						." ERROR: $msg " . PHP_EOL
						." Query: $sql_query "
						, logger::ERROR
					);
					return false;
				}
			} else {
				debug_log(__METHOD__
					." WARNING: Table '$matrix_table' does not have 'id' column. Skipping PK constraint creation."
					, logger::WARNING
				);
			}
		}//end foreach ($ar_constraint as $matrix_table => $ar_constraint_to_change)


		return true;
	}//end rename_constraint



	/**
	* RECREATE_DB_ASSETS
	* Forces the full rebuild of all PostgreSQL schema assets after schema migration.
	*
	* Runs these db_tasks methods in sequence:
	* 1. create_extensions   — ensures required PostgreSQL extensions (e.g. pgcrypto, unaccent) exist.
	* 2. rebuild_constraints — re-adds foreign keys and check constraints that were dropped.
	* 3. rebuild_functions   — re-creates all user-defined PL/pgSQL functions.
	* 4. rebuild_indexes     — re-creates all JSONB and standard indexes for the v7 schema.
	* 5. exec_maintenance    — runs VACUUM ANALYZE and REINDEX (long-running; should be last).
	*
	* Individual task failures are recorded in response->errors but do not abort the remaining
	* tasks. The caller should inspect response->errors and response->success_count afterwards.
	*
	* @return object - stdClass with properties:
	*   result  stdClass  — per-task result keyed by task name, plus success_count/total_count.
	*   msg     string    — human-readable summary.
	*   errors  array     — collected error messages from all tasks.
	*   success int       — number of tasks that returned a truthy result.
	*/
	public static function recreate_db_assets() : object {

		$response = new stdClass();
		$response->result	= new stdClass();
		$response->msg		= 'Request done with errors';
		$response->errors	= [];
		$response->success	= 0;

		$tasks = [
			'extensions'  => 'create_extensions',
			'constraints' => 'rebuild_constraints',
			'functions'   => 'rebuild_functions',
			'indexes'     => 'rebuild_indexes',
			'maintenance' => 'exec_maintenance' // long time process (vacuum, reindex, etc)
		];

		foreach ($tasks as $process_name => $method) {

			// CLI feedback
			if (running_in_cli()) {
				if (!isset(common::$pdata)) {
					common::$pdata = new stdClass();
					common::$pdata->counter = 0;
				}
				common::$pdata->msg = (label::get_label('processing') ?? 'Processing') . ": recreate_db_assets | $process_name -> $method";
				common::$pdata->memory = (common::$pdata->counter % 100 === 0)
					? dd_memory_usage()
					: (common::$pdata->memory ?? '');
				common::$pdata->counter++;
				print_cli(common::$pdata);
			}

			// Execute task
			if (method_exists('db_tasks', $method)) {
				$task_response = db_tasks::$method();

				$response->result->{$process_name} = $task_response->result ?? null;

				if (!empty($task_response->errors)) {
					$response->errors = array_merge($response->errors, (array)$task_response->errors);
				}

				if (($task_response->result ?? false) !== false) {
					$response->success++;
				}
			} else {
				$msg = "Skipped task '$process_name': method db_tasks::$method does not exist";
				debug_log(__METHOD__ . " WARNING: $msg", logger::WARNING);
				$response->errors[] = $msg;
			}
		}

		$response->result->success_count = $response->success;
		$response->result->total_count   = count($tasks);

		if (empty($response->errors)) {
			$response->msg = 'Request done successfully';
		}

		return $response;
	}//end recreate_db_assets



	/**
	 * REMOVE_TM_CREATED_SECTIONS
	 *
	 * Cleans up the Time Machine table by removing section-level create/update records.
	 * In Dédalo v7, the history of data is stored at the component level. Section-level
	 * records in TM are only preserved for the 'deleted' state to track deletions.
	 *
	 * @return bool True if the cleanup was successful, false otherwise.
	 */
	public static function remove_tm_created_sections() : bool {

		// CLI feedback
		if (running_in_cli()) {
			if (!isset(common::$pdata)) {
				common::$pdata = new stdClass();
			}
			common::$pdata->msg = (label::get_label('processing') ?? 'Processing') . ": remove_tm_created_sections";
			print_cli(common::$pdata);
		}

		$sql_query = sanitize_query('
			DO $$
			BEGIN
				IF EXISTS (
					SELECT 1
					FROM information_schema.columns
					WHERE table_name = \'' . static::$table_matrix_time_machine . '\'
					AND column_name = \'state\'
				) THEN
					DELETE FROM "' . static::$table_matrix_time_machine . '"
					WHERE "section_tipo" = "tipo"
					  AND ("state" != \'deleted\' OR "state" IS NULL);
				END IF;
			END $$;
		');

		$result = matrix_db_manager::exec_sql($sql_query);

		if ($result === false) {
			$msg = 'Failed to remove TM created sections';
			debug_log(__METHOD__
				. " ERROR: $msg " . PHP_EOL
				. " Query: $sql_query "
				, logger::ERROR
			);
			return false;
		}

		return true;
	}//end remove_tm_created_sections



	/**
	 * RECREATE_TM_TABLE
	 *
	 * Extends the `matrix_time_machine` table with new columns required by the v7 schema:
	 * `user_id`, `bulk_process_temp`, and `data`. Also adds relevant documentation via SQL comments.
	 *
	 * @return bool True if the table was successfully updated, false otherwise.
	 */
	public static function recreate_tm_table() : bool {

		// CLI feedback
		if (running_in_cli()) {
			if (!isset(common::$pdata)) {
				common::$pdata = new stdClass();
			}
			common::$pdata->msg = (label::get_label('processing') ?? 'Processing') . ": recreate_tm_table";
			print_cli(common::$pdata);
		}

		$sql_query = sanitize_query ('
			ALTER TABLE "' . static::$table_matrix_time_machine . '"
				ADD COLUMN IF NOT EXISTS "user_id" character varying(8) NULL,
				ADD COLUMN IF NOT EXISTS "bulk_process_temp" integer NULL,
				ADD COLUMN IF NOT EXISTS "data" jsonb NULL;

			COMMENT ON TABLE "' . static::$table_matrix_time_machine . '" IS \'Time Machine\';

			COMMENT ON COLUMN ' . static::$table_matrix_time_machine . '.section_id IS \'section_id when the change was made\';
			COMMENT ON COLUMN ' . static::$table_matrix_time_machine . '.section_tipo IS \'section_tipo when the change was made\';
			COMMENT ON COLUMN ' . static::$table_matrix_time_machine . '.tipo IS \'component tipo or section tipo when the change was made\';
			COMMENT ON COLUMN ' . static::$table_matrix_time_machine . '.lang IS \'component data lang of the change\';
			COMMENT ON COLUMN ' . static::$table_matrix_time_machine . '.timestamp IS \'timestamp of the change\';
			COMMENT ON COLUMN ' . static::$table_matrix_time_machine . '.user_id IS \'User section_id that made the change\';
			COMMENT ON COLUMN ' . static::$table_matrix_time_machine . '.bulk_process_temp IS \'Bulk process id that identify a bulk change - copy\';
			COMMENT ON COLUMN ' . static::$table_matrix_time_machine . '.data IS \'JSONB data representing the change\';
		');

		$result = matrix_db_manager::exec_sql($sql_query);

		if ($result === false) {
			$msg = "Failed to update matrix_time_machine schema";
			debug_log(__METHOD__
				. " ERROR: $msg " . PHP_EOL
				. " Query: $sql_query "
				, logger::ERROR
			);
			return false;
		}

		return true;
	}//end recreate_tm_table



	/**
	* FILL_NEW_COLUMNS_IN_TM
	* Copies v6 Time Machine column values into their v7 equivalents.
	*
	* Column mapping performed by a single bulk UPDATE:
	* - 'userID'          → 'user_id'         (camelCase to snake_case; content identical)
	* - 'bulk_process_id' → 'bulk_process_temp' (temporarily renamed to avoid constraint
	*                        conflicts; later renamed back by rename_tm_column_bulk_process())
	* - 'dato'            → 'data'             (v6 used 'dato'; v7 uses 'data')
	*
	* Prerequisites: recreate_tm_table() must have been called first to add the target columns.
	* Silently succeeds (returns true) when the source columns ('userID', 'bulk_process_id',
	* 'dato') do not exist, which means the migration was already completed.
	*
	* @return bool - true on success or when source columns are absent, false on SQL error.
	*/
	public static function fill_new_columns_in_tm() : bool {

		$column_exists = DBi::check_column_exists(static::$table_matrix_time_machine, 'userID');
		if(!$column_exists) {
			debug_log(__METHOD__
				." WARNING: Ignore fill_new_columns_in_tm because userID column does not exist"
				, logger::WARNING
			);
			return true;
		}

		// Check if bulk_process_id column exists (source for migration)
		$bulk_process_id_exists = DBi::check_column_exists(static::$table_matrix_time_machine, 'bulk_process_id');
		if(!$bulk_process_id_exists) {
			debug_log(__METHOD__
				." WARNING: Ignore fill_new_columns_in_tm because bulk_process_id column does not exist"
				, logger::WARNING
			);
			return true;
		}

		// Check if dato column exists (source for migration)
		$dato_exists = DBi::check_column_exists(static::$table_matrix_time_machine, 'dato');
		if(!$dato_exists) {
			debug_log(__METHOD__
				." WARNING: Ignore fill_new_columns_in_tm because dato column does not exist"
				, logger::WARNING
			);
			return true;
		}

		$sql_query = sanitize_query ('
			UPDATE "' . static::$table_matrix_time_machine . '"
				SET user_id 		  = "userID",
					bulk_process_temp = bulk_process_id,
					data 			  = dato;
		');

		$result = matrix_db_manager::exec_sql($sql_query);

		if($result===false) {
			$msg = "Failed Update matrix_time_machine new columns with its data";
			debug_log(__METHOD__
				." ERROR: $msg "
				, logger::ERROR
			);
			return false;
		}


		return true;
	}//end fill_new_columns_in_tm



	/**
	* DELETE_TM_COLUMNS
	* Drops obsolete v6 columns from `matrix_time_machine` after data has been migrated
	* into the v7 equivalents by fill_new_columns_in_tm().
	*
	* Columns removed:
	* - 'section_id_key' — v5-era composite key helper; superseded by (section_id, section_tipo).
	* - 'state'          — section-level create/update/delete state; v7 tracks this differently.
	* - 'userID'         — replaced by 'user_id' (see fill_new_columns_in_tm).
	* - 'dato'           — replaced by 'data' (see fill_new_columns_in_tm).
	*
	* Uses IF EXISTS guards so the statement is idempotent and safe to re-run.
	*
	* (!) Must only be called AFTER fill_new_columns_in_tm() has successfully completed.
	*
	* @return bool - true on success, false on SQL error.
	*/
	public static function delete_tm_columns() : bool {

		$sql_query = sanitize_query ('
			ALTER TABLE "' . static::$table_matrix_time_machine . '"
				DROP COLUMN IF EXISTS "section_id_key",
				DROP COLUMN IF EXISTS "state",
				DROP COLUMN IF EXISTS "userID",
				DROP COLUMN IF EXISTS "dato";
		');

		$result = matrix_db_manager::exec_sql($sql_query);

		if($result===false) {
			$msg = "Failed to delete tm section_id_key and state columns";
			debug_log(__METHOD__
				." ERROR: $msg "
				, logger::ERROR
			);
			return false;
		}


		return true;
	}//end delete_tm_columns



	/**
	* RENAME_TM_COLUMN_BULK_PROCESS
	* Renames the staging column 'bulk_process_temp' back to its final name 'bulk_process_id'
	* in the `matrix_time_machine` table.
	*
	* Why the two-step rename?
	* fill_new_columns_in_tm() copies the old 'bulk_process_id' value into 'bulk_process_temp'
	* instead of directly into 'bulk_process_id', because the source column and the target column
	* share the same name and a single UPDATE cannot write to a column while reading from it in
	* some PostgreSQL planner paths. Once the old 'bulk_process_id' column is dropped (by
	* delete_tm_columns), this method finalizes the rename.
	*
	* Guards against:
	* - 'bulk_process_temp' absent → already renamed or migration not run; returns true silently.
	* - 'bulk_process_id' already present → rename would cause a name collision; returns true.
	*
	* @return bool - true on success or when rename is not needed, false on SQL error.
	*/
	public static function rename_tm_column_bulk_process() : bool {

		// column 'bulk_process_temp' already exists check
		$bulk_process_temp_exists = DBi::check_column_exists(static::$table_matrix_time_machine, 'bulk_process_temp');
		if($bulk_process_temp_exists===false) {
			debug_log(__METHOD__
				." WARNING: Ignore rename_tm_column_bulk_process because bulk_process_temp column does not exist"
				, logger::WARNING
			);
			return true;
		}

		// column 'bulk_process_id' already exists check
		$bulk_process_id_exists = DBi::check_column_exists(static::$table_matrix_time_machine, 'bulk_process_id');
		if($bulk_process_id_exists===true) {
			debug_log(__METHOD__
				." WARNING: Ignore rename_tm_column_bulk_process because bulk_process_id column already exists"
				, logger::WARNING
			);
			return true;
		}

		$sql_query = sanitize_query ('
			ALTER TABLE "' . static::$table_matrix_time_machine . '" RENAME COLUMN bulk_process_temp TO bulk_process_id;
		');

		$result = matrix_db_manager::exec_sql($sql_query);

		if($result===false) {
			$msg = "Failed to rename tm bulk_process_temp column to bulk_process_id";
			debug_log(__METHOD__
				." ERROR: $msg "
				, logger::ERROR
			);
			return false;
		}


		return true;
	}//end rename_tm_column_bulk_process



	/**
	* CREATE_MATRIX_ACTIVITY_DIFFUSION_TABLE
	* Creates the `matrix_activity_diffusion` table by executing the canonical SQL DDL file
	* from the install/db directory.
	*
	* This table tracks diffusion (publishing) events per activity record and is part of the
	* v7 diffusion subsystem. The DDL is read from disk rather than inlined here so that the
	* install and upgrade paths share a single authoritative schema definition.
	*
	* (!) Requires DEDALO_ROOT_PATH to be defined and the file
	*     install/db/matrix_activity_diffusion.sql to be present and readable.
	*
	* @return bool - true on success, false on SQL error.
	*/
	public static function create_matrix_activity_diffusion_table() : bool {

		$sql_file = DEDALO_ROOT_PATH . '/install/db/matrix_activity_diffusion.sql';
		$sql_query = file_get_contents($sql_file);

		if ($sql_query === false) {
			$msg = "Failed to read SQL file: $sql_file";
			debug_log(__METHOD__
				." ERROR: $msg "
				, logger::ERROR
			);
			return false;
		}

		$result = matrix_db_manager::exec_sql($sql_query);

		if($result===false) {
			$msg = "Failed to create matrix_activity_diffusion table ";
			debug_log(__METHOD__
				." ERROR: $msg "
				, logger::ERROR
			);
			return false;
		}


		return true;
	}//end create_matrix_activity_diffusion_table



	/**
	 * CREATE_STRING_SEARCH_STORE
	 *
	 * Creates the v7 per-value text-search store `matrix_string_search`
	 * (extension btree_gin, table, sync trigger function, composite trigram
	 * index — DDL in install/db/matrix_string_search.sql, all idempotent),
	 * installs the `{table}_string_search_sync` row trigger on every existing
	 * string-searchable matrix table, and BACKFILLS the store from the
	 * migrated data (TRUNCATE + INSERT..SELECT — safe to re-run).
	 *
	 * (!) Must run at the END of the pipeline:
	 *  - after recreate_db_assets (needs f_unaccent and pg_trgm), and
	 *  - after every data migration that writes string values (the backfill
	 *    must read the FINAL v7 data; later writes stay in sync via the
	 *    triggers themselves).
	 * The TS engine gates its search pre-filter on the trigger presence per
	 * table: a trigger without backfilled rows would wrongly EXCLUDE records
	 * from searches, so the backfill is correctness, not an optimization.
	 *
	 * @return bool True when the store, triggers and backfill completed.
	 */
	public static function create_string_search_store() : bool {

		// DDL: extension + table + trigger function + indexes (idempotent)
			$sql_query = file_get_contents(DEDALO_ROOT_PATH . '/install/db/matrix_string_search.sql');
			$result = matrix_db_manager::exec_sql($sql_query);
			if($result===false) {
				debug_log(__METHOD__
					." ERROR: Failed to create matrix_string_search store (DDL) "
					, logger::ERROR
				);
				return false;
			}

		// The string-searchable matrix tables (the all_matrix_string_gin_idx
		// list minus the log tables matrix_activity / matrix_activity_diffusion
		// / matrix_stats — mirror of the TS ar_trigger declaration). Tables
		// absent on this installation are skipped.
			$ar_tables = [
				'matrix',
				'matrix_activities',
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
				'matrix_test',
				'matrix_tools',
				'matrix_users'
			];

		// Backfill is TRUNCATE + re-insert so a re-run never duplicates rows.
			$result = matrix_db_manager::exec_sql('TRUNCATE public.matrix_string_search;');
			if($result===false) {
				debug_log(__METHOD__
					." ERROR: Failed to truncate matrix_string_search before backfill "
					, logger::ERROR
				);
				return false;
			}

		$conn = DBi::_getConnection();
		foreach ($ar_tables as $table) {

			// skip tables not present on this installation
				$exists_result = pg_query_params(
					$conn,
					"SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = $1",
					[$table]
				);
				if ($exists_result===false || pg_num_rows($exists_result)===0) {
					continue;
				}

			// CLI feedback
				if (running_in_cli()) {
					if (!isset(common::$pdata)) {
						common::$pdata = new stdClass();
					}
					common::$pdata->msg = " Creating string search trigger + backfill for table: $table";
					print_cli(common::$pdata);
				}

			$escaped_table = pg_escape_identifier($conn, $table);

			// trigger (drop + create = idempotent re-run)
				$sql_query = sanitize_query('
					DROP TRIGGER IF EXISTS "'.$table.'_string_search_sync" ON '.$escaped_table.';
					CREATE TRIGGER "'.$table.'_string_search_sync"
					AFTER INSERT OR DELETE OR UPDATE OF string, section_id, section_tipo ON '.$escaped_table.'
					FOR EACH ROW EXECUTE FUNCTION public.matrix_string_search_sync();
				');
				$result = matrix_db_manager::exec_sql($sql_query);
				if($result===false) {
					debug_log(__METHOD__
						." ERROR: Failed to create string search trigger on table '$table' "
						, logger::ERROR
					);
					return false;
				}

			// backfill this table's values
				$sql_query = sanitize_query('
					INSERT INTO public.matrix_string_search (section_tipo, section_id, component_tipo, string)
					SELECT m.section_tipo, m.section_id, kv.key, lower(public.f_unaccent(e->>\'value\'))
					FROM '.$escaped_table.' m, jsonb_each(m.string) kv, jsonb_array_elements(kv.value) e
					WHERE m.string IS NOT NULL
					  AND jsonb_typeof(kv.value) = \'array\'
					  AND e->>\'value\' IS NOT NULL
					  AND e->>\'value\' <> \'\';
				');
				$result = matrix_db_manager::exec_sql($sql_query);
				if($result===false) {
					debug_log(__METHOD__
						." ERROR: Failed to backfill matrix_string_search from table '$table' "
						, logger::ERROR
					);
					return false;
				}
		}

		return true;
	}//end create_string_search_store



	/**
	 * CREATE_RELATION_INDEX_STORE
	 *
	 * Creates the v7 per-locator relation index `matrix_relation_index`
	 * (table, sync trigger function, three btree indexes — DDL in
	 * install/db/matrix_relation_index.sql, all idempotent), installs the
	 * `{table}_relation_index_sync` row trigger on every existing
	 * string-searchable matrix table, and BACKFILLS the index from the
	 * migrated data (TRUNCATE + INSERT..SELECT — safe to re-run). Locators
	 * whose section_id is not a signed integer are skipped (the TS engine's
	 * relation integrity report enumerates them).
	 *
	 * (!) Must run at the END of the pipeline, after every data migration
	 * that writes relation values — the TS engine gates its inverse-search
	 * fast path on trigger presence + a non-empty index, so the backfill is
	 * part of the correctness contract, not an optimization.
	 *
	 * @return bool True when the store, triggers and backfill completed.
	 */
	public static function create_relation_index_store() : bool {

		// DDL: table + trigger function + indexes (idempotent)
			$sql_query = file_get_contents(DEDALO_ROOT_PATH . '/install/db/matrix_relation_index.sql');
			$result = matrix_db_manager::exec_sql($sql_query);
			if($result===false) {
				debug_log(__METHOD__
					." ERROR: Failed to create matrix_relation_index store (DDL) "
					, logger::ERROR
				);
				return false;
			}

		// Same content-table list as the string search store (log tables
		// excluded — the v6 relations table indexed activity logs and paid
		// ~50M rows for it). Tables absent on this installation are skipped.
			$ar_tables = [
				'matrix',
				'matrix_activities',
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
				'matrix_test',
				'matrix_tools',
				'matrix_users'
			];

		// Backfill is TRUNCATE + re-insert so a re-run never duplicates rows.
			$result = matrix_db_manager::exec_sql('TRUNCATE public.matrix_relation_index;');
			if($result===false) {
				debug_log(__METHOD__
					." ERROR: Failed to truncate matrix_relation_index before backfill "
					, logger::ERROR
				);
				return false;
			}

		$conn = DBi::_getConnection();
		foreach ($ar_tables as $table) {

			// skip tables not present on this installation
				$exists_result = pg_query_params(
					$conn,
					"SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name = $1",
					[$table]
				);
				if ($exists_result===false || pg_num_rows($exists_result)===0) {
					continue;
				}

			// CLI feedback
				if (running_in_cli()) {
					if (!isset(common::$pdata)) {
						common::$pdata = new stdClass();
					}
					common::$pdata->msg = " Creating relation index trigger + backfill for table: $table";
					print_cli(common::$pdata);
				}

			$escaped_table = pg_escape_identifier($conn, $table);

			// trigger (drop + create = idempotent re-run)
				$sql_query = sanitize_query('
					DROP TRIGGER IF EXISTS "'.$table.'_relation_index_sync" ON '.$escaped_table.';
					CREATE TRIGGER "'.$table.'_relation_index_sync"
					AFTER INSERT OR DELETE OR UPDATE OF relation, section_id, section_tipo ON '.$escaped_table.'
					FOR EACH ROW EXECUTE FUNCTION public.matrix_relation_index_sync();
				');
				$result = matrix_db_manager::exec_sql($sql_query);
				if($result===false) {
					debug_log(__METHOD__
						." ERROR: Failed to create relation index trigger on table \'$table\' "
						, logger::ERROR
					);
					return false;
				}

			// backfill this table\'s locators
				$sql_query = sanitize_query('
					INSERT INTO public.matrix_relation_index (section_tipo, section_id, from_component_tipo, type, target_section_tipo, target_section_id)
					SELECT m.section_tipo, m.section_id, kv.key, e->>\'type\', e->>\'section_tipo\', (e->>\'section_id\')::int
					FROM '.$escaped_table.' m, jsonb_each(m.relation) kv, jsonb_array_elements(kv.value) e
					WHERE m.relation IS NOT NULL
					  AND jsonb_typeof(kv.value) = \'array\'
					  AND e->>\'section_tipo\' IS NOT NULL
					  AND e->>\'section_id\' ~ \'^-?[0-9]+$\';
				');
				$result = matrix_db_manager::exec_sql($sql_query);
				if($result===false) {
					debug_log(__METHOD__
						." ERROR: Failed to backfill matrix_relation_index from table \'$table\' "
						, logger::ERROR
					);
					return false;
				}
		}

		return true;
	}//end create_relation_index_store



	/**
	 * DROP_LEGACY_DATOS_COLUMN
	 *
	 * Removes the legacy 'datos' column from the specified tables after successful data migration.
	 *
	 * @param array $ar_tables List of database tables to process.
	 * @return bool True if all columns were successfully dropped or didn't exist, false on error.
	 */
	public static function drop_legacy_datos_column(array $ar_tables) : bool {

		$conn = DBi::_getConnection();

		foreach ($ar_tables as $table) {
			// CLI feedback
			if (running_in_cli()) {
				if (!isset(common::$pdata)) {
					common::$pdata = new stdClass();
				}
				common::$pdata->msg = " Dropping legacy 'datos' column from table: $table";
				print_cli(common::$pdata);
			}

			$escaped_table = pg_escape_identifier($conn, $table);
			$escaped_table_name = pg_escape_string($conn, $table);

			$sql_query = sanitize_query("
				DO $$
				BEGIN
					IF EXISTS (
						SELECT 1
						FROM information_schema.columns
						WHERE table_name = '$escaped_table_name'
						AND column_name = 'datos'
					) THEN
						ALTER TABLE $escaped_table DROP COLUMN \"datos\";
					END IF;
				END $$;
			");

			$result = matrix_db_manager::exec_sql($sql_query);

			if ($result === false) {
				$msg = "Failed to drop legacy 'datos' column from table '$table'";
				debug_log(__METHOD__ . " ERROR: $msg", logger::ERROR);
				return false;
			}
		}

		return true;
	}//end drop_legacy_datos_column



	/**
	* CHANGE_NOTIFICATIONS_TABLE_COLUMN_NAME
	* Renames the 'datos' column to 'data' in the `matrix_notifications` table.
	*
	* This is the very first step of pre_update() because the update process itself
	* writes PID and status entries into `matrix_notifications`, and the new v7 code
	* expects the column to be named 'data'. Running this before any other migration
	* step ensures compatibility even if later steps fail and need to be retried.
	*
	* Uses an anonymous DO block with an IF EXISTS guard so the statement is idempotent
	* and safe to re-run after a partial failure.
	*
	* @return bool - true on success, false on SQL error.
	*/
	public static function change_notifications_table_column_name() : bool {

		$sql_query = sanitize_query('
			DO $$
			BEGIN
				IF EXISTS (
					SELECT 1
					FROM information_schema.columns
					WHERE table_name = \'matrix_notifications\'
					AND column_name = \'datos\'
				) THEN
					EXECUTE \'ALTER TABLE "matrix_notifications" RENAME COLUMN "datos" TO "data"\';
				END IF;
			END $$;
		');

		$result = matrix_db_manager::exec_sql($sql_query);

		if($result===false) {
			$msg = "Failed to change notifications table column name";
			debug_log(__METHOD__
				." ERROR: $msg "
				, logger::ERROR
			);
			return false;
		}

		return true;
	}//end change_notifications_table_column_name



	/**
	 * MIGRATE_SEARCH_PRESETS_V6_TO_V7
	 *
	 * Migrates search preset data from v6 to v7 format by adding mandatory `id` properties.
	 * Presets are stored in `matrix_list` table, section_tipo 'dd655', component_json 'dd625'.
	 * (!) This feature is in process of implementation.
	 *
	 * Transformation rules:
	 * - Add `"id": 1` to top-level preset object
	 * - When `q` is not null: add `"id": 1` to each item in the `q` array
	 * - When `q` is null: remove any existing `id` property from the filter item
	 * - Idempotent: skips already-converted data (checks for top-level id)
	 *
	 * @param bool $save If true, saves changes to DB. If false, dry-run only.
	 * @return object Standard response with result, msg, errors
	 */
	public static function migrate_search_presets_v6_to_v7(bool $save) : object {

		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Error. Request failed';
			$response->errors	= [];

		debug_log(__METHOD__ . PHP_EOL
			. ' ))))))))))))))))))))))))))))))))))))))))))))))))))))))) ' . PHP_EOL
			. ' MIGRATING SEARCH PRESETS ... ' . PHP_EOL
			. ' ))))))))))))))))))))))))))))))))))))))))))))))))))))))) ' . PHP_EOL
			, logger::WARNING
		);

		// CLI process data initialization
		if (running_in_cli() === true) {
			if (!isset(common::$pdata)) {
				common::$pdata = new stdClass();
			}
			common::$pdata->table		= 'matrix_list';
			common::$pdata->memory		= '';
			common::$pdata->counter		= 0;
			common::$pdata->modified	= 0;
		}

		$conn		= DBi::_getConnection();
		$table		= 'matrix_list';
		$section_tipo	= 'dd655'; // temp presets section tipo
		$component_tipo	= 'dd625'; // component_json tipo

		$escaped_table = pg_escape_identifier($conn, $table);

		// Query records with section_tipo dd655
		$strQuery = "
			SELECT id, section_id, misc
			FROM $escaped_table
			WHERE section_tipo = $1
		";
		$result = matrix_db_manager::exec_search($strQuery, [$section_tipo]);

		if ($result === false) {
			$msg = "Failed to query matrix_list for section_tipo $section_tipo";
			debug_log(__METHOD__ . " ERROR: $msg", logger::ERROR);
			$response->errors[] = $msg;
			return $response;
		}

		$rows_processed	= 0;
		$rows_modified	= 0;

		while ($row = pg_fetch_assoc($result)) {

			$id		= $row['id'];
			$section_id	= $row['section_id'];
			$misc_json	= $row['misc'];

			// CLI process data status
			if (running_in_cli() === true) {
				common::$pdata->msg = (label::get_label('processing') ?? 'Processing') . ': ' . __METHOD__
					. ' | table: ' . $table
					. ' | id: ' . $id
					. ' | section_id: ' . $section_id;
				common::$pdata->memory = (common::$pdata->counter % 5000 === 0)
					? dd_memory_usage()
					: common::$pdata->memory;
				common::$pdata->counter++;
				print_cli(common::$pdata);
			}

			if (empty($misc_json)) {
				continue;
			}

			$misc = json_handler::decode($misc_json);
			if (empty($misc) || !isset($misc->{$component_tipo})) {
				continue;
			}

			$preset_data = $misc->{$component_tipo};

			// Check if already migrated (idempotent check)
			if (is_array($preset_data) && isset($preset_data[0]) && is_object($preset_data[0]) && isset($preset_data[0]->id)) {
				// Already has top-level id, skip
				continue;
			}

			// Transform the preset data
			$transformed = self::transform_search_preset($preset_data);

			if ($transformed === null) {
				// No changes needed
				continue;
			}

			// Update misc with transformed data
			$misc->{$component_tipo} = $transformed;
			$new_misc_json = json_handler::encode($misc, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

			$update_query = "
				UPDATE $escaped_table
				SET misc = $1
				WHERE id = $2
			";

			if ($save) {
				$update_result = matrix_db_manager::exec_search($update_query, [$new_misc_json, $id]);
				if ($update_result === false) {
					$msg = "Failed to update matrix_list id $id";
					debug_log(__METHOD__ . " ERROR: $msg", logger::ERROR);
					$response->errors[] = $msg;
					continue;
				}
			}

			$rows_modified++;
			$rows_processed++;
		}

		pg_free_result($result);

		$response->result	= empty($response->errors);
		$response->msg		= empty($response->errors)
			? "Migration completed. Processed: $rows_processed, Modified: $rows_modified"
			: 'Request done with errors (' . count($response->errors) . ')';
		$response->processed	= $rows_processed;
		$response->modified	= $rows_modified;

		return $response;
	}//end migrate_search_presets_v6_to_v7



	/**
	* TRANSFORM_SEARCH_PRESET
	* Transforms a single search preset from v6 to v7 format by assigning the mandatory
	* top-level 'id' property and recursively processing nested filter operators ($and/$or).
	*
	* In v7, every preset wrapper object must carry id:1 so the UI can address it by id.
	* The method mutates the preset object in place (stdClass properties are passed by reference)
	* and wraps the result back in a single-element array to match the storage shape.
	*
	* Returns null (no-op) when:
	* - $preset_data is empty or its first element is not a stdClass.
	* - The preset already has an 'id' property (idempotent guard).
	*
	* @param array $preset_data - single-element array containing the preset stdClass.
	* @return array|null - the transformed single-element array, or null when no change is needed.
	*/
	private static function transform_search_preset(array $preset_data) : ?array {

		if (empty($preset_data) || !isset($preset_data[0])) {
			return null;
		}

		$preset = $preset_data[0];

		if (!is_object($preset)) {
			return null;
		}

		// Check if already has id (idempotent)
		if (isset($preset->id)) {
			return null;
		}

		// Add id to top-level preset
		$preset->id = 1;

		// Process value object if exists
		if (isset($preset->value) && is_object($preset->value)) {
			self::process_filter_operators($preset->value);
		}

		return [$preset];
	}//end transform_search_preset



	/**
	* PROCESS_FILTER_OPERATORS
	* Entry point for recursive filter-tree transformation.
	* Dispatches '$and' and '$or' arrays from a filter value object to process_filter_items(),
	* which handles the per-item id assignment and deeper recursion.
	*
	* Called by transform_search_preset() on the top-level 'value' object of a preset.
	*
	* @param object $filter_object - filter value object that may contain '$and' and/or '$or' arrays.
	* @return void
	*/
	private static function process_filter_operators(object $filter_object) : void {

		// Process $and array if exists
		if (isset($filter_object->{'$and'}) && is_array($filter_object->{'$and'})) {
			self::process_filter_items($filter_object->{'$and'});
		}

		// Process $or array if exists
		if (isset($filter_object->{'$or'}) && is_array($filter_object->{'$or'})) {
			self::process_filter_items($filter_object->{'$or'});
		}
	}//end process_filter_operators



	/**
	* PROCESS_FILTER_ITEMS
	* Iterates over a flat array of filter item objects, assigning id:1 to each item's
	* 'q' entries (when q is a non-null array), or removing the 'id' property (when q is null).
	* Descends into nested '$and'/'$or' arrays by calling itself recursively.
	*
	* Mutation semantics: array items are modified by reference via 'foreach … &$filter_item';
	* the caller's array is updated in place. The trailing 'unset($filter_item)' is required
	* to break the reference after the loop (standard PHP safety pattern).
	*
	* @param array $filter_items - array of filter item stdClass objects (may be deeply nested).
	* @return void
	*/
	private static function process_filter_items(array $filter_items) : void {

		foreach ($filter_items as &$filter_item) {

			if (!is_object($filter_item)) {
				continue;
			}

			// Check for nested operators ($and or $or) - recurse into them
			if (isset($filter_item->{'$and'}) && is_array($filter_item->{'$and'})) {
				self::process_filter_items($filter_item->{'$and'});
				continue; // Skip further processing for nested operator objects
			}

			if (isset($filter_item->{'$or'}) && is_array($filter_item->{'$or'})) {
				self::process_filter_items($filter_item->{'$or'});
				continue; // Skip further processing for nested operator objects
			}

			// Handle q property for regular filter items
			if (property_exists($filter_item, 'q')) {

				if ($filter_item->q !== null && is_array($filter_item->q)) {
					// q is array: add id to each item
					foreach ($filter_item->q as &$q_item) {
						if (is_object($q_item) && !isset($q_item->id)) {
							$q_item->id = 1;
						}
					}
					unset($q_item);
				} elseif ($filter_item->q === null) {
					// q is null: remove id property if exists
					if (isset($filter_item->id)) {
						unset($filter_item->id);
					}
				}
			}
		}
		unset($filter_item);
	}//end process_filter_items



	/**
	* INTIFY_SECTION_ID_LOCATORS
	*
	* section_id → int unification sweep (v7 WC-2026-08-10-section-id-int-canonical).
	* Rewrites every locator-carried section_id / section_id_key / parent_section_id
	* stored as a CONVERTIBLE STRING inside the migrated jsonb columns into the
	* canonical int form, so the TS engine boots on int-clean data.
	*
	* THE CONVERSION RULE (shared verbatim with the v7 kernel through the vector
	* file run/lib/section_id_conversion_vectors.json — self-checked below before
	* any write): strict numeric, no leading zero ('0' converts, '-0' does not),
	* within IEEE-754 safe-int range. NEGATIVES ARE VALID (-1 root, -666 activity).
	* Everything else is reported under a finding class and NEVER cast:
	*   external/skip-tipo locators (zenon zero-padded remote ids), leading-zero,
	*   out-of-range, '', 'null', tokens ('self', '${section_id}'), floats, null.
	*
	* ORDERING (updates.php): after reformat_matrix_data / reformat_matrix_time_
	* machine_data / the dataframe migrations (their OUTPUT is what gets intified),
	* BEFORE create_string_search_store / create_relation_index_store so the
	* derived stores are backfilled from int-form locators.
	*
	* Idempotent: a second run finds nothing convertible and changes 0 rows.
	* On success (save=true) writes the section_id_int_normalize marker row into
	* matrix_updates — the machine-readable evidence the v7 engine's future
	* contraction release checks at boot. (get_current_data_version is guarded
	* with `WHERE data ? 'dedalo_version'` so the marker cannot shadow the
	* version rows.)
	*
	* @param array|null $ar_tables  Tables to sweep; null = the full default set
	*                               (matrix content tables + matrix_time_machine + dd_ontology).
	* @param bool $save             false = dry-run (report only), true = write.
	* @param array $skip_tipos      section_tipo values whose locators are skipped
	*                               wholesale (external services — the string IS the
	*                               remote id). Belt on top of the leading-zero rule.
	* @return object response { result: bool, msg: string, converted: int, purged: int, findings: object }
	*/
	public static function intify_section_id_locators( ?array $ar_tables=null, bool $save=true, array $skip_tipos=['zenon1'] ) : object {

		$response = new stdClass();
			$response->result		= false;
			$response->msg			= 'Error. Request failed';
			$response->converted	= 0;
			$response->changed_rows	= 0;
			$response->findings		= new stdClass();

		set_time_limit(0);

		// SELF-CHECK against the shared vector file (the same vectors the v7 bun
		// gate asserts). A drifted rule here silently corrupts addresses — refuse.
			$vectors_file = dirname(dirname(dirname(dirname(__FILE__)))) . '/../run/lib/section_id_conversion_vectors.json';
			$vectors_path = realpath($vectors_file);
			if ($vectors_path===false) {
				// engine/core/base/upgrade → package root is 4 levels up from engine/
				$vectors_path = dirname(__FILE__, 5) . '/run/lib/section_id_conversion_vectors.json';
			}
			$vectors_raw = is_string($vectors_path) ? @file_get_contents($vectors_path) : false;
			if ($vectors_raw===false) {
				$response->msg = 'intify_section_id_locators: conversion vector file not found — refusing to run unverified';
				debug_log(__METHOD__ . ' ' . $response->msg . ' (' . $vectors_path . ')', logger::ERROR);
				return $response;
			}
			$vectors = json_handler::decode($vectors_raw);
			foreach ($vectors->vectors as $vector) {
				$converted_value = self::intify_convert_section_id($vector->input);
				$is_convertible  = ($converted_value!==null);
				if ($is_convertible !== $vector->convertible
					|| ($is_convertible && $converted_value !== (int)$vector->output)) {
					$response->msg = 'intify_section_id_locators: conversion rule DRIFTED from the shared vectors at input "'.$vector->input.'" — refusing to run';
					debug_log(__METHOD__ . ' ' . $response->msg, logger::ERROR);
					return $response;
				}
			}

		// Default sweep set: every migrated content table (the reformat list) plus
		// the TM snapshots (a restore must not re-inject strings) and dd_ontology.
			$default_tables = [
				'matrix', 'matrix_activities', 'matrix_activity', 'matrix_activity_diffusion',
				'matrix_dataframe', 'matrix_dd', 'matrix_hierarchy', 'matrix_hierarchy_main',
				'matrix_indexations', 'matrix_langs', 'matrix_layout', 'matrix_layout_dd',
				'matrix_list', 'matrix_nexus', 'matrix_nexus_main', 'matrix_notes',
				'matrix_ontology', 'matrix_ontology_main', 'matrix_profiles', 'matrix_projects',
				'matrix_stats', 'matrix_test', 'matrix_tools', 'matrix_users',
				'matrix_time_machine',
				'dd_ontology'
			];
			$tables = $ar_tables ?? $default_tables;

		// Columns per table: TM stores its payload in `data`; dd_ontology carries
		// locators in `relations` (`properties` is a config DSL — named exemption,
		// its 'self'/'current' markers are tokens by design and must not be touched;
		// the walk would only report them, but excluding it keeps the sweep exact).
			$jsonb_columns = ['data','relation','string','date','iri','geo','number','media','misc','relation_search','meta'];

		$conn			= DBi::_getConnection();
		$skip_map		= array_fill_keys($skip_tipos, true);
		$total_converted= 0;
		$total_purged	= 0;
		$changed_rows	= 0;
		$scanned_rows	= 0;
		$findings		= []; // class => ['count'=>n, 'samples'=>[...]]
		// Batch size is ADAPTIVE on bytes, not just rows. A fixed row count with an
		// unbounded payload size is a foreseeable OOM on exactly the large installs this
		// sweep targets: the scan ships every matching jsonb column of the batch (the
		// old per-column shape shipped one), and $writes then holds a second encoded
		// copy. A PHP memory fatal is an Error, which update::run_scripts' catch
		// (Exception) does NOT catch, so it would kill phase 2 hours in. Starting lower
		// and adapting to the measured payload keeps a batch near the budget whatever
		// the row width; the open transaction rolls back and the step is idempotent, so
		// the worst case stays a re-run rather than a half-written table.
		$batch_size			= 250;
		$batch_size_max		= 1000;
		$batch_size_min		= 25;
		$batch_bytes_budget	= 64 * 1024 * 1024;
		$started		= microtime(true);

		// THROUGHPUT. This is a bulk rewrite, not transactional business work, and on a
		// large install it is the longest step of the whole migration. Three properties
		// of the loop below are what make it finish (the naive shape ran at a few dozen
		// rows/second, i.e. >24h for 2M rows and weeks for 50-100M):
		//   1. ONE pass per TABLE, not one per column. All candidate columns are read in
		//      the same row, so the table is scanned (and its jsonb detoasted) once
		//      instead of 11 times, and a row needing several columns fixed produces ONE
		//      new row version instead of up to 11 — far less WAL, bloat and index churn.
		//   2. Writes are grouped per batch into a single multi-row
		//      UPDATE … FROM (VALUES …) per changed-column signature: one round trip per
		//      batch instead of one per row.
		//   3. Each batch is ONE explicit transaction, with synchronous_commit off.
		//      Row-at-a-time autocommit means one fsync per row, which is the actual
		//      ceiling in the old shape. The step is idempotent and runs after the
		//      phase-1 backup, so the async-commit window (a host crash can lose the
		//      last commits) costs at most a re-run of this same step.
			$sync_commit_off = false;
			if ($save===true) {
				$sync_commit_off = (pg_query($conn, 'SET synchronous_commit = off')!==false);
			}

		foreach ($tables as $table) {

			// skip tables not present on this installation
				$exists_result = pg_query_params(
					$conn,
					"SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name=$1",
					[$table]
				);
				if ($exists_result===false || pg_num_rows($exists_result)===0) {
					continue;
				}

			$columns = ($table==='matrix_time_machine')
				? ['data']
				: (($table==='dd_ontology') ? ['relations'] : $jsonb_columns);

			// keep only the columns this installation actually has
				$present = [];
				foreach ($columns as $column) {
					$col_result = pg_query_params(
						$conn,
						"SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
						[$table, $column]
					);
					if ($col_result!==false && pg_num_rows($col_result)>0) {
						$present[] = $column;
					}
				}
				if (empty($present)) {
					continue;
				}

			$escaped_table	= pg_escape_identifier($conn, $table);
			// (!) EVERY swept table pages on `id`, dd_ontology included. Its `id` IS a
			// NOT NULL PRIMARY KEY (create_dd_ontology_table: ALTER id SET NOT NULL +
			// ADD CONSTRAINT dd_ontology_id_pkey PRIMARY KEY (id)); `tipo` is only
			// UNIQUE, and UNIQUE is not NOT NULL — it is CTAS'd from the nullable
			// jer_dd.terminoID and never constrained afterwards, so an old install can
			// carry NULL-tipo rows. Paging on a nullable key breaks three ways:
			// `NULL > 'x'` is NULL so such a row is silently never swept (yet the
			// success marker is still written); if it lands in a write batch the
			// `WHERE t.tipo = v.pk` matches 0 rows and the affected-rows assert aborts
			// the migration; and in dry-run `$last_pk` becomes null, which resets the
			// keyset to TRUE and re-fetches the same batch forever.
			$pk				= 'id';
			$escaped_pk		= pg_escape_identifier($conn, $pk);
			$pk_cast		= 'bigint';

			// Candidate test. A string-typed address serialises as
			// "section_id": "…" / "section_id_key": "…" / "parent_section_id": "…"
			// (!) jsonb::text renders a space after the colon, hence the \s*.
				// (!) POSIX class, NOT \s. A backslash inside a plain SQL string literal is
				// reinterpreted when standard_conforming_strings is off (legal, still
				// settable per-cluster/per-role in PG17): `\s` degrades to `s` with only a
				// WARNING, every candidate test then fails, and the sweep reports success
				// and writes the section_id_int_normalize marker having converted nothing.
				// [[:space:]] is the same matcher with no escape to lose.
				$rx = '\'"(section_id|section_id_key|parent_section_id)":[[:space:]]*"\'';

			// The CASE is evaluated inside a LATERAL closed with OFFSET 0 — an
			// optimisation fence that stops the planner flattening the subquery, so each
			// column is detoasted and matched ONCE per row and the very same value feeds
			// both the WHERE and the target list. Non-matching columns come back NULL and
			// are never shipped to PHP, which is what keeps the payload transfer small.
				$select_parts	= [];
				$any_parts		= [];
				foreach ($present as $i => $column) {
					$c = 't.' . pg_escape_identifier($conn, $column);
					$select_parts[]	= "CASE WHEN $c::text ~ $rx THEN $c::text END AS c$i";
					$any_parts[]	= "x.c$i IS NOT NULL";
				}
				$lateral	= 'SELECT ' . implode(', ', $select_parts) . ' OFFSET 0';
				$any_sql	= '(' . implode(' OR ', $any_parts) . ')';
				$sel_out	= [];
				foreach ($present as $i => $column) {
					$sel_out[] = "x.c$i";
				}

			$last_pk = null;
			while (true) {

				$where_pk	= ($last_pk===null) ? 'TRUE' : "t.$escaped_pk > \$1";
				$params		= ($last_pk===null) ? [] : [$last_pk];
				$sql_query	= "
					SELECT t.$escaped_pk AS pk, " . implode(', ', $sel_out) . "
					FROM $escaped_table AS t
					CROSS JOIN LATERAL ($lateral) AS x
					WHERE $where_pk
					  AND $any_sql
					ORDER BY t.$escaped_pk ASC
					LIMIT $batch_size";
				$batch_result = pg_query_params($conn, $sql_query, $params);
				if ($batch_result===false) {
					$response->msg = "intify_section_id_locators: batch read failed on $table: " . pg_last_error($conn);
					debug_log(__METHOD__ . ' ' . $response->msg, logger::ERROR);
					if ($sync_commit_off===true) { pg_query($conn, 'RESET synchronous_commit'); }
					return $response;
				}
				$rows = pg_fetch_all($batch_result) ?: [];
				if (count($rows)===0) {
					break;
				}

				// signature => ['cols'=>[column,…], 'rows'=>[[pk, json, …], …]]
				$writes			= [];
				$batch_bytes	= 0;

				foreach ($rows as $row) {

					$last_pk = $row['pk'];
					$scanned_rows++;

					$row_changed = []; // column => encoded json
					foreach ($present as $i => $column) {

						$payload = $row['c'.$i] ?? null;
						if ($payload===null) {
							continue; // no string-typed address in this column
						}
						$batch_bytes += strlen($payload);
						$decoded = json_handler::decode($payload);
						if ($decoded===null) {
							continue;
						}

						$stats = new stdClass();
							$stats->converted	= 0;
							$stats->findings	= [];
						$changed = self::intify_walk($decoded, $skip_map, $stats);

						// findings tally (identity-sampled so the operator can adjudicate)
							foreach ($stats->findings as $finding) {
								$class = $finding['class'];
								if (!isset($findings[$class])) {
									$findings[$class] = ['count'=>0, 'samples'=>[]];
								}
								$findings[$class]['count']++;
								if (count($findings[$class]['samples']) < 25) {
									$findings[$class]['samples'][] = $table.'.'.$column.' '.$pk.'='.$row['pk']
										. ' tipo='.($finding['tipo'] ?? '?')
										. ' value='.json_handler::encode($finding['value']);
								}
							}

						if ($changed!==true) {
							continue;
						}
						$total_converted	+= $stats->converted;
						$row_changed[$column]= json_handler::encode($decoded);
					}

					if (empty($row_changed)) {
						continue;
					}
					// (!) COUNTED PER (row, column), NOT per row. The marker row written
					// below is a shared contract: the v7 sibling writer
					// (scripts/migrate_section_id_locators.ts) sweeps one table.column
					// "surface" at a time and increments its changedRows per surface, so
					// a row fixed in two columns counts twice there. Counting once per
					// row here would silently make the two writers of the same
					// section_id_int_normalize marker disagree.
					$changed_rows += count($row_changed);
					if ($save!==true) {
						continue;
					}

					$signature = implode(',', array_keys($row_changed));
					if (!isset($writes[$signature])) {
						$writes[$signature] = ['cols'=>array_keys($row_changed), 'rows'=>[]];
					}
					$writes[$signature]['rows'][] = array_merge([$row['pk']], array_values($row_changed));
				}

				// flush the batch: one transaction, one UPDATE per changed-column signature
					if ($save===true && !empty($writes)) {

						if (pg_query($conn, 'BEGIN')===false) {
							$response->msg = "intify_section_id_locators: BEGIN failed on $table: " . pg_last_error($conn);
							debug_log(__METHOD__ . ' ' . $response->msg, logger::ERROR);
							if ($sync_commit_off===true) { pg_query($conn, 'RESET synchronous_commit'); }
							return $response;
						}

						foreach ($writes as $signature => $write) {

							$set_parts	= [];
							$value_cols	= ['pk'];
							foreach ($write['cols'] as $j => $column) {
								$set_parts[]	= pg_escape_identifier($conn, $column) . " = v.v$j::jsonb";
								$value_cols[]	= "v$j";
							}

							$tuples		= [];
							$up_params	= [];
							$n			= 1;
							foreach ($write['rows'] as $write_row) {
								$placeholders	= ['$' . $n++ . '::' . $pk_cast];
								$total_cols		= count($write['cols']);
								for ($j=0; $j<$total_cols; $j++) {
									$placeholders[] = '$' . $n++ . '::text';
								}
								$tuples[] = '(' . implode(',', $placeholders) . ')';
								foreach ($write_row as $write_value) {
									$up_params[] = $write_value;
								}
							}

							$sql_update = "UPDATE $escaped_table AS t
								SET " . implode(', ', $set_parts) . "
								FROM (VALUES " . implode(',', $tuples) . ") AS v(" . implode(',', $value_cols) . ")
								WHERE t.$escaped_pk = v.pk";
							$update_result = pg_query_params($conn, $sql_update, $up_params);
							if ($update_result===false || pg_affected_rows($update_result)!==count($write['rows'])) {
								pg_query($conn, 'ROLLBACK');
								$response->msg = "intify_section_id_locators: batch UPDATE failed on $table ($signature)"
									. ' — expected ' . count($write['rows']) . ' rows, affected '
									. ($update_result===false ? 'ERROR' : pg_affected_rows($update_result))
									. ' — aborting';
								debug_log(__METHOD__ . ' ' . $response->msg . ' ' . pg_last_error($conn), logger::ERROR);
								if ($sync_commit_off===true) { pg_query($conn, 'RESET synchronous_commit'); }
								return $response;
							}
						}

						if (pg_query($conn, 'COMMIT')===false) {
							// ROLLBACK first: a failed COMMIT can leave the session in an
							// aborted transaction, where every further statement — including
							// the RESET below — is discarded, and the connection would go
							// back to the runner with synchronous_commit still off.
							pg_query($conn, 'ROLLBACK');
							$response->msg = "intify_section_id_locators: COMMIT failed on $table: " . pg_last_error($conn);
							debug_log(__METHOD__ . ' ' . $response->msg, logger::ERROR);
							if ($sync_commit_off===true) { pg_query($conn, 'RESET synchronous_commit'); }
							return $response;
						}
					}

				// adapt the next batch to the payload weight actually observed
					if ($batch_bytes > $batch_bytes_budget && $batch_size > $batch_size_min) {
						$batch_size = max($batch_size_min, intdiv($batch_size, 2));
					} else if ($batch_bytes < intdiv($batch_bytes_budget, 4) && $batch_size < $batch_size_max) {
						$batch_size = min($batch_size_max, $batch_size * 2);
					}

				// CLI feedback (rate included: this step is long enough that the
				// operator needs to see it is progressing and how fast)
					if ( running_in_cli()===true ) {
						if (!isset(common::$pdata)) {
							common::$pdata = new stdClass();
						}
						$elapsed	= max(0.001, microtime(true) - $started);
						common::$pdata->msg = ' intify_section_id_locators'
							. ' | ' . ($save===true ? 'APPLY' : 'DRY-RUN')
							. ' | ' . $table
							. ' | last ' . $pk . ': ' . $last_pk
							. ' | candidate rows: ' . $scanned_rows
							. ' | converted: ' . $total_converted
							. ' | changed rows: ' . $changed_rows
							. ' | ' . round($scanned_rows / $elapsed, 1) . ' rows/s';
						print_cli(common::$pdata);
					}
			}
		}

			if ($sync_commit_off===true) {
				pg_query($conn, 'RESET synchronous_commit');
			}


		// report
			$findings_report = new stdClass();
			foreach ($findings as $class => $info) {
				$findings_report->$class = (object)['count'=>$info['count'], 'samples'=>$info['samples']];
			}
			$response->findings		= $findings_report;
			$response->converted	= $total_converted;
			$response->changed_rows	= $changed_rows;

		debug_log(__METHOD__ . PHP_EOL
			. ' ))))))))))))))))))))))))))))))))))))))))))))))))))))))) ' . PHP_EOL
			. ' intify_section_id_locators ' . ($save===true ? 'APPLY' : 'DRY-RUN') . ' complete' . PHP_EOL
			. ' converted: ' . $total_converted . ' | changed rows: ' . $changed_rows . PHP_EOL
			. ' findings: ' . json_handler::encode($findings_report) . PHP_EOL
			. ' ))))))))))))))))))))))))))))))))))))))))))))))))))))))) ' . PHP_EOL
			, logger::WARNING
		);

		// marker row (save runs only): the machine-readable evidence for the v7
		// contraction boot check. NOT a version row — both version readers are
		// guarded with `data ? 'dedalo_version'`.
			if ($save===true) {
				$marker = json_handler::encode([
					'section_id_int_normalize' => [
						'date'			=> date('Y-m-d H:i:s'),
						'converted'		=> $total_converted,
						'changed_rows'	=> $changed_rows,
						'findings'		=> $findings_report,
						'origin'		=> 'close_v6_prepare_v7'
					]
				]);
				$marker_result = pg_query_params(
					$conn,
					'INSERT INTO "matrix_updates" ("data") VALUES ($1::jsonb)',
					[$marker]
				);
				if ($marker_result===false) {
					$response->msg = 'intify_section_id_locators: marker row INSERT failed: ' . pg_last_error($conn);
					debug_log(__METHOD__ . ' ' . $response->msg, logger::ERROR);
					return $response;
				}
			}

		$response->result	= true;
		$response->msg		= 'OK. intify_section_id_locators ' . ($save===true ? 'applied' : 'dry-run')
			. '. converted: ' . $total_converted . ', changed rows: ' . $changed_rows;

		return $response;
	}//end intify_section_id_locators



	/**
	* INTIFY_CONVERT_SECTION_ID
	* The shared conversion rule, one place (vector-checked at run start):
	* returns the int for a convertible string, null for everything else.
	* Mirrors v7 concepts/section_id.ts isConvertibleSectionIdString exactly.
	* @param mixed $value
	* @return int|null
	*/
	public static function intify_convert_section_id( $value ) : ?int {

		if (!is_string($value)) {
			return null;
		}
		if (preg_match('/^(-?[1-9][0-9]*|0)$/', $value)!==1) {
			return null;
		}
		// IEEE-754 safe-int range (the v7 engine is JS): |n| <= 2^53-1
		$number = (float)$value;
		if (abs($number) > 9007199254740991.0) {
			return null;
		}
		return (int)$value;
	}//end intify_convert_section_id



	/**
	* INTIFY_WALK
	* Recursive in-place walk of a decoded jsonb value (mirror of the v7 kernel
	* src/core/update/transform/section_id_intify.ts): converts the address keys
	* of every object, recurses through arrays/objects, NEVER descends into
	* string scalars (inline tag markers are a pinned wire edge).
	* @param mixed &$value  decoded jsonb (objects as stdClass)
	* @param array $skip_map  section_tipo => true for external skips
	* @param object $stats  {converted:int, findings:array}
	* @return bool  true when anything was converted
	*/
	public static function intify_walk( &$value, array $skip_map, object $stats ) : bool {

		$changed = false;

		if (is_array($value)) {
			foreach ($value as &$element) {
				if (self::intify_walk($element, $skip_map, $stats)===true) {
					$changed = true;
				}
			}
			unset($element);
			return $changed;
		}

		if (!is_object($value)) {
			return false; // scalars (incl. strings) are never descended into
		}

		// address keys of the locator shape
		foreach (['section_id', 'section_id_key', 'parent_section_id'] as $key) {

			if (!property_exists($value, $key)) {
				continue;
			}
			$tipo_key	= ($key==='section_id_key') ? 'section_tipo_key' : 'section_tipo';
			$tipo		= (property_exists($value, $tipo_key) && is_string($value->$tipo_key))
				? $value->$tipo_key
				: null;

			// LOCATOR LAW: no paired tipo key → not a locator (e.g. a
			// component_json user value carrying a 'section_id' key) → untouched.
				if ($tipo===null) {
					continue;
				}

			$current = $value->$key;

			if (is_int($current)) {
				// PHP ints reach 2^63 but the v7 engine is JS: beyond 2^53-1 the
				// address is not representable — report, never pass as canonical.
				if (abs($current) > 9007199254740991) {
					$stats->findings[] = ['class'=>'out-of-range', 'tipo'=>$tipo, 'value'=>$current];
				}
				continue;
			}
			if (is_float($current)) {
				$stats->findings[] = ['class'=>((float)(int)$current===$current ? 'out-of-range' : 'float'), 'tipo'=>$tipo, 'value'=>$current];
				continue;
			}
			if ($current===null) {
				$stats->findings[] = ['class'=>'null-value', 'tipo'=>$tipo, 'value'=>null];
				continue;
			}
			if (!is_string($current)) {
				$stats->findings[] = ['class'=>'other', 'tipo'=>$tipo, 'value'=>$current];
				continue;
			}

			$converted = self::intify_convert_section_id($current);
			if ($converted!==null) {
				// A CONVERTIBLE string converts ON ANY TIPO — an address-shaped value
				// is an address. True external remote ids are never convertible
				// (zenon zero-padded, wikidata opaque); the skip list below guards
				// only the non-convertible remote-id forms.
				$value->$key = $converted;
				$stats->converted++;
				$changed = true;
				continue;
			}

			// external/skip tipo: the NON-convertible string IS the remote id
				if ($tipo!==null && isset($skip_map[$tipo])) {
					$stats->findings[] = ['class'=>'external-skip', 'tipo'=>$tipo, 'value'=>$current];
					continue;
				}

			// classed finding (mirror of the v7 kernel classes)
				if ($current==='') {
					$class = 'empty';
				} else if ($current==='null') {
					$class = 'null-literal';
				} else if (preg_match('/^-?[0-9]+$/', $current)===1 || $current==='-0') {
					// numeric-shaped but not convertible: leading zeros or out of range
					$class = (preg_match('/^(-?[1-9][0-9]*|0)$/', $current)===1) ? 'out-of-range' : 'leading-zero';
				} else {
					$class = 'token';
				}
				$stats->findings[] = ['class'=>$class, 'tipo'=>$tipo, 'value'=>$current];
		}

		// recurse into the object's own values
		foreach (get_object_vars($value) as $property => $property_value) {
			if (self::intify_walk($value->$property, $skip_map, $stats)===true) {
				$changed = true;
			}
		}

		return $changed;
	}//end intify_walk



}//end class v6_to_v7
