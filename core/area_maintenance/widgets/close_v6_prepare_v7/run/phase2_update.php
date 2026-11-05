<?php declare(strict_types=1);
/**
* PHASE 2 — full data + schema update  (bundled-engine process)
*
* Runs in a FRESH engine process (after phase 1 created dd_ontology), so the
* ontology cache is clean — the CLI equivalent of the pre_update → logout →
* login → update boundary in the interactive flow.
*
* Builds an ALL-STEPS-TRUE updates_checked map from the v7.0.0 descriptor and
* calls update::update_version(). update_version() skips any step key that is not
* === true (see class.update.php), so every SQL_update / components_update /
* run_scripts entry must be present and true. That runs the entire pipeline,
* INCLUDING the final steps already registered in updates.php:
*   create_matrix_activity_diffusion_table,
*   create_string_search_store   (matrix_string_search + triggers + backfill),
*   create_relation_index_store  (matrix_relation_index + triggers + backfill).
* On full success update_version() records the new version in matrix_updates.
*
* Exit codes: 0 ok · 2 usage/boot · 3 no matching descriptor · 5 update failed ·
*             9 died on an uncaught throwable (see prepare_v7_fail_loud) ·
*             10 ontology update missing (ontology43/44 not in jer_dd)
*
* @package Dédalo
* @subpackage close_v6_prepare_v7
*/

require_once __DIR__ . '/lib/engine_boot.php';
$paths = prepare_v7_boot_engine();

$opts     = getopt('', ['yes', 'log:']);
$has_yes  = isset($opts['yes']);
$log_file = $opts['log'] ?? ($paths['var_dir'] . '/prepare_v7.log');

$log = function(string $line) use ($log_file) : void {
	@file_put_contents($log_file, date('c') . ' [phase2] ' . $line . PHP_EOL, FILE_APPEND | LOCK_EX);
	fwrite(STDOUT, $line . PHP_EOL);
};

// uncaught throwable / fatal ⇒ logged + non-zero exit (never a silent "success")
prepare_v7_fail_loud($log_file, 'phase2');

if (!$has_yes) {
	$log('Refusing to run update_version without --yes.');
	exit(2);
}

$log('REAL RUN start. db=' . (defined('DEDALO_DATABASE_CONN') ? DEDALO_DATABASE_CONN : '?'));

// version gate + descriptor alignment. This process is FRESH (phase 1 exited), so the
// PREPARE_V7_UPDATE_FROM export must be re-applied here before update::get_updates().
$gate = prepare_v7_version_gate::check();
$log('version gate: ' . $gate->msg);
if ($gate->result !== true) {
	$log('ABORT: database not eligible for the v6→v7 migration.');
	exit(3);
}
if ($gate->aligned === true) {
	prepare_v7_version_gate::apply_update_from($gate);
	$log('descriptor update_from aligned to ' . implode('.', $gate->current)
		. ' (declared minimum: ' . implode('.', $gate->expected) . ').');
}

// ontology prerequisites: re-checked in this fresh process, before any write
$ontology_gate = prepare_v7_version_gate::check_ontology_prerequisites();
$log('ontology prerequisites: ' . $ontology_gate->msg);
if ($ontology_gate->result !== true) {
	$log('ABORT: the v6 ontology update has not been run (ontology43/ontology44 missing).');
	exit(10);
}

// select the descriptor matching the current DB version (same logic as the engine)
$current = get_current_data_version();
$updates = update::get_updates();
$descriptor = null;
foreach ($updates as $u) {
	if (($current[0] ?? null) == $u->update_from_major
		&& ($current[1] ?? null) == $u->update_from_medium
		&& ($current[2] ?? null) == $u->update_from_minor) {
		$descriptor = $u;
		break;
	}
}
if ($descriptor === null) {
	$log('ABORT: no update descriptor matches current version '
		. (empty($current) ? '[none]' : implode('.', $current))
		. '. Did phase 1 run?');
	exit(3);
}
$log('descriptor: → ' . $descriptor->version_major . '.' . $descriptor->version_medium . '.' . $descriptor->version_minor);

// build ALL-STEPS-TRUE map
$checked = new stdClass();
foreach (['SQL_update', 'components_update', 'run_scripts'] as $group) {
	if (isset($descriptor->$group) && is_array($descriptor->$group)) {
		foreach ($descriptor->$group as $i => $_) {
			$key = $group . '_' . $i;
			$checked->$key = true;
		}
	}
}
$log('steps enabled: ' . count(get_object_vars($checked))
	. ' (SQL_update=' . count($descriptor->SQL_update ?? [])
	. ', components_update=' . count($descriptor->components_update ?? [])
	. ', run_scripts=' . count($descriptor->run_scripts ?? []) . ')');

// raise time limit for large datasets (matches the widget: 3 days)
set_time_limit(259200);

// run the full pipeline
try {
	$res = update::update_version($checked);
} catch (\Throwable $e) {
	$log('EXCEPTION in update_version: ' . $e->getMessage());
	exit(5);
}

$ok = ($res->result ?? false) === true;
$log('update_version(): result=' . var_export($ok, true));
if (isset($res->msg)) {
	$log('msg: ' . (is_array($res->msg) ? implode(' | ', array_map('strval', $res->msg)) : (string)$res->msg));
}
if (!empty($res->errors)) {
	foreach (array_slice((array)$res->errors, 0, 100) as $e) { $log('  · ' . (is_string($e) ? $e : json_encode($e))); }
}

if (!$ok) {
	$log('ABORT: update_version failed. Inspect the log and restore from backup if needed.');
	exit(5);
}

$log('PHASE 2 done. Database migrated to the v7 data model (stores + backfills provisioned).');
exit(0);
