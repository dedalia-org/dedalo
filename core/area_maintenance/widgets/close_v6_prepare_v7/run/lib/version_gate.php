<?php declare(strict_types=1);
/**
* VERSION_GATE — verify the connected DB is eligible for the v6→v7 migration.
*
* The migration descriptor (updates.php, v7.0.0 block) declares a MINIMUM source
* version in update_from_* and force_update_mode = 'clean'. Running the pipeline
* against an older/other DB would corrupt data. This gate reads the current data
* version from the connected DB (get_current_data_version() reads the
* matrix_updates table) BEFORE any write and accepts the range
*
*     update_from  <=  current  <  target      (e.g. 6.9.1 <= current < 7.0.0)
*
* i.e. ANY v6 at or after the minimum, not just the exact minimum: v6 keeps
* releasing data updates (6.9.2, 6.9.3, …) that do not change what this migration
* reads, so pinning the cutover to one exact version would strand every install
* that stayed current.
*
* The ENGINE, however, selects the descriptor by an EXACT match on update_from
* (update::pre_update_version() / update_version()). So once this gate accepts a
* later version, apply_update_from() exports it in PREPARE_V7_UPDATE_FROM, which
* the descriptor reads to align itself — see engine/core/base/update/updates.php.
* Without the export nothing changes: the descriptor keeps its literal minimum.
*
* A version is not enough on its own: check_ontology_prerequisites() also verifies the
* OUTCOME of the ontology update the migration needs (ontology43 / ontology44 in jer_dd).
*
* @package Dédalo
* @subpackage close_v6_prepare_v7
*/
final class prepare_v7_version_gate {

	/** Env var the descriptor reads to align update_from with the actual DB version. */
	public const UPDATE_FROM_ENV = 'PREPARE_V7_UPDATE_FROM';


	/**
	* CHECK
	* @return object - {
	*   result:   bool,          eligible to migrate
	*   current:  array,         [major,medium,minor] currently in the DB
	*   target:   array|null,    version this migration would produce
	*   expected: array,         minimum update_from the descriptor requires
	*   aligned:  bool,          true when current > expected (descriptor needs the env export)
	*   msg:      string
	* }
	*/
	public static function check() : object {

		$response = new stdClass();
			$response->result	= false;
			$response->current	= [];
			$response->target	= null;
			$response->expected	= [];
			$response->aligned	= false;
			$response->msg		= '';

		if (!function_exists('get_current_data_version') || !class_exists('update')) {
			$response->msg = 'Engine not booted: get_current_data_version()/update not available.';
			return $response;
		}

		$current = array_map('intval', (array)get_current_data_version());
		$response->current = $current;

		if (count($current) !== 3) {
			$response->msg = 'NOT eligible. No data version found in matrix_updates '
				. '(fresh or non-Dédalo database).';
			return $response;
		}

		$updates = update::get_updates();

		// the migration descriptor: the one this package ships (single v7 block).
		$first = array_key_first((array)$updates);
		if ($first === null) {
			$response->msg = 'NOT eligible. No update descriptor found in updates.php.';
			return $response;
		}
		$u = $updates->$first;

		$response->expected	= [(int)$u->update_from_major, (int)$u->update_from_medium, (int)$u->update_from_minor];
		$response->target	= [(int)$u->version_major, (int)$u->version_medium, (int)$u->version_minor];

		// too old: below the minimum this migration was written against
		if (self::compare($current, $response->expected) < 0) {
			$response->msg = 'NOT eligible. DB data version (matrix_updates): ' . implode('.', $current)
				. '. This migration requires ' . implode('.', $response->expected) . ' or later '
				. '(see updates.php v7.0.0 update_from). Update the v6 install first.';
			return $response;
		}

		// already at/beyond the target: nothing to do here
		if (self::compare($current, $response->target) >= 0) {
			$response->msg = 'NOT eligible. DB data version (matrix_updates): ' . implode('.', $current)
				. ' is already at or beyond the migration target ' . implode('.', $response->target)
				. '. This database looks migrated.';
			return $response;
		}

		$response->result	= true;
		$response->aligned	= (self::compare($current, $response->expected) > 0);
		$response->msg		= 'Eligible: DB at ' . implode('.', $current)
			. ' (>= ' . implode('.', $response->expected) . ')'
			. ' → will migrate to ' . implode('.', $response->target) . '.';

		return $response;
	}//end check


	/**
	* CHECK_ONTOLOGY_PREREQUISITES
	* An OUTCOME check, not a version one: the machine-name components (ontology43 / ontology44)
	* reach a v6 install through an ontology update, not a data update, so a data version alone
	* proves nothing. Without them in jer_dd, migrate_ontology_machine_names cannot run and their
	* values would be dropped as orphan tipos. A refusal, never forceable (no flag skips it).
	* Reads the legacy "terminoID" column, present before and after pre_update.
	* @return object - { result: bool, missing: string[], msg: string }
	*/
	public static function check_ontology_prerequisites() : object {

		$response = new stdClass();
			$response->result	= false;
			$response->missing	= [];
			$response->msg		= '';

		if (!class_exists('matrix_db_manager') || !class_exists('v6_to_v7')) {
			$response->msg = 'Engine not booted: matrix_db_manager/v6_to_v7 not available.';
			return $response;
		}

		$required	= [v6_to_v7::MACHINE_NAME_TIPO, v6_to_v7::USE_MACHINE_NAME_TIPO];
		$jer_dd		= v6_to_v7::$table_jer_dd;

		$result = matrix_db_manager::exec_search(
			'SELECT "terminoID" FROM "' . $jer_dd . '" WHERE "terminoID" = ANY($1)',
			['{' . implode(',', $required) . '}']
		);
		if ($result === false) {
			$response->missing	= $required;
			$response->msg		= 'NOT eligible. Cannot read ' . $jer_dd . ' to check the ontology nodes '
				. implode(', ', $required) . '.';
			return $response;
		}

		$found = [];
		while ($row = pg_fetch_assoc($result)) {
			$found[] = $row['terminoID'];
		}

		$response->missing = array_values(array_diff($required, $found));
		if (!empty($response->missing)) {
			$response->msg = 'NOT eligible. Ontology node(s) ' . implode(', ', $response->missing)
				. ' missing from ' . $jer_dd . ': run the ontology update first, then re-run.';
			return $response;
		}

		$response->result	= true;
		$response->msg		= 'Ontology nodes present: ' . implode(', ', $required) . '.';

		return $response;
	}//end check_ontology_prerequisites


	/**
	* APPLY_UPDATE_FROM
	* Exports the DB's actual version so the descriptor aligns its update_from with it.
	* MUST be called after a passing check() and BEFORE update::get_updates() /
	* pre_update_version() / update_version(), because the engine selects the descriptor
	* by an exact match and updates.php re-reads the env on every include.
	*
	* Only affects THIS process (putenv) and its children; a normal engine boot with no
	* export keeps the literal minimum in updates.php.
	*
	* @param object $gate - a check() response
	* @return bool - true when the export was applied
	*/
	public static function apply_update_from(object $gate) : bool {

		if (($gate->result ?? false) !== true || count((array)($gate->current ?? [])) !== 3) {
			return false;
		}

		putenv(self::UPDATE_FROM_ENV . '=' . implode('.', $gate->current));

		return true;
	}//end apply_update_from


	/**
	* COMPARE
	* Numeric [major,medium,minor] comparison
	* @param array $a
	* @param array $b
	* @return int - -1 | 0 | 1
	*/
	private static function compare(array $a, array $b) : int {

		for ($i = 0; $i < 3; $i++) {
			$x = (int)($a[$i] ?? 0);
			$y = (int)($b[$i] ?? 0);
			if ($x !== $y) {
				return ($x < $y) ? -1 : 1;
			}
		}

		return 0;
	}//end compare


}//end prepare_v7_version_gate
