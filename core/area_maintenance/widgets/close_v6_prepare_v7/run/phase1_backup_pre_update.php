<?php declare(strict_types=1);
/**
* PHASE 1 — backup + pre_update  (bundled-engine process)
*
* Runs in its OWN engine process. Two modes:
*
*   --dry-run  : PREFLIGHT only, writes nothing. Verifies the version gate, DB
*                connectivity and that pg_dump can actually dump THIS server (a
*                client older than the server refuses), then runs the data reformat
*                in REVIEW mode (save=false) to surface bad-data errors. An unusable
*                pg_dump FAILS the preflight (exit 4) unless --skip-backup is given:
*                the backup is the real run's first step, so it is a blocker.
*
*   (real)     : requires --yes. Takes a BLOCKING full pg_dump (abort on failure
*                unless --skip-backup), then runs update::pre_update_version(),
*                which creates dd_ontology from jer_dd. This must complete before
*                phase 2, whose fresh process then has a clean ontology cache
*                (mirroring the pre_update → logout → login → update boundary).
*
* Exit codes: 0 ok · 2 usage/boot · 3 not eligible · 4 backup failed ·
*             5 pre_update failed · 6 preflight data errors ·
*             9 died on an uncaught throwable (see prepare_v7_fail_loud) ·
*             10 ontology update missing (ontology43/44 not in jer_dd)
*
* @package Dédalo
* @subpackage close_v6_prepare_v7
*/

require_once __DIR__ . '/lib/engine_boot.php';
$paths = prepare_v7_boot_engine();

$opts        = getopt('', ['dry-run', 'skip-backup', 'yes', 'no-auto-fix', 'backup-dir:', 'log:']);
$is_dry      = isset($opts['dry-run']);
$skip_backup = isset($opts['skip-backup']);
$has_yes     = isset($opts['yes']);
$no_auto_fix = isset($opts['no-auto-fix']);
$backup_dir  = $opts['backup-dir'] ?? ($paths['var_dir'] . '/backup');
$log_file    = $opts['log']        ?? ($paths['var_dir'] . '/prepare_v7.log');

/** append one line to the log file and echo it */
$log = function(string $line) use ($log_file) : void {
	$stamp = date('c') . ' [phase1] ';
	@file_put_contents($log_file, $stamp . $line . PHP_EOL, FILE_APPEND | LOCK_EX);
	fwrite(STDOUT, $line . PHP_EOL);
};

// uncaught throwable / fatal ⇒ logged + non-zero exit (never a silent "success")
prepare_v7_fail_loud($log_file, 'phase1');

$log(($is_dry ? 'PREFLIGHT' : 'REAL RUN') . ' start. db=' . (defined('DEDALO_DATABASE_CONN') ? DEDALO_DATABASE_CONN : '?'));

// 1. version gate --------------------------------------------------------------
// Accepts the range [update_from, target) — any v6 at or after the descriptor's
// minimum. When the DB is PAST the minimum the descriptor must be told, because the
// engine selects it by an exact match (see version_gate::apply_update_from).
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

// 1b. ontology prerequisites ----------------------------------------------------
// The machine-name components arrive by an ontology update, not a data update: check the
// outcome, before any write. A refusal, never forceable.
$ontology_gate = prepare_v7_version_gate::check_ontology_prerequisites();
$log('ontology prerequisites: ' . $ontology_gate->msg);
if ($ontology_gate->result !== true) {
	$log('ABORT: the v6 ontology update has not been run (ontology43/ontology44 missing).');
	$log('  Run the ontology update in the v6 Maintenance area first, then re-run.');
	exit(10);
}

// 2. DB connectivity sanity ----------------------------------------------------
$ping = false;
try {
	$res  = DBi::_getConnection();
	$ping = ($res !== false);
} catch (\Throwable $e) {
	$log('DB connection error: ' . $e->getMessage());
}
if ($ping !== true) {
	$log('ABORT: cannot connect to the database.');
	exit(2);
}
$log('DB connectivity: OK');

// 3. pg_dump availability AND version compatibility ----------------------------
// Present is not enough: pg_dump refuses to dump a server newer than itself, which
// would abort the migration at its first step. The preflight must surface that here.
$pg_check	= prepare_v7_backup::check_pg_dump();
$pg_dump_ok	= ($pg_check->result === true);
$log('pg_dump (' . $pg_check->pg_dump . '): ' . ($pg_dump_ok ? $pg_check->msg : 'UNUSABLE'));
if (!$pg_dump_ok) {
	$log('  ' . $pg_check->msg);
}

// ---------------------------------------------------------------------- DRY RUN
if ($is_dry) {

	// A blocker, not a warning: the backup is the real run's FIRST step, so an unusable
	// pg_dump means the migration cannot start. Reporting "PREFLIGHT OK" here would be a
	// false green — the whole point of the preflight is to catch this before the button.
	// --skip-backup (a manual backup already in hand) downgrades it to a warning.
	if (!$pg_dump_ok) {
		if ($skip_backup) {
			$log('WARNING: pg_dump is unusable, but --skip-backup was passed: the real run would '
				. 'proceed WITHOUT a backup. Make sure you have a current one.');
		}else{
			$log('PREFLIGHT FAILED: the mandatory pre-migration backup cannot run.');
			$log('  ' . $pg_check->msg);
			$log('  Fix it, or re-run the preflight with --skip-backup if you already have a backup.');
			exit(4);
		}
	}

	// data-review pass (save=false): review EXACTLY the tables the real run reformats
	// (from the descriptor), so the preflight exercises the same code path on the same
	// data. Discovery is only the fallback, and is also used to report v6 tables that
	// still carry a legacy `datos` column but are NOT in the migration list.
	$ar_tables  = prepare_v7_migration_tables();
	$discovered = prepare_v7_discover_datos_tables();

	if (empty($ar_tables)) {
		$log('WARNING: the descriptor declares no reformat_matrix_data table list; '
			. 'falling back to discovery.');
		$ar_tables = $discovered;
	}

	$log('data-review tables (' . count($ar_tables) . '): ' . implode(', ', $ar_tables));

	$untouched = array_values(array_diff($discovered, $ar_tables));
	if (!empty($untouched)) {
		$log('NOTE: these tables carry a legacy `datos` column but are NOT reformatted into the '
			. 'typed v7 columns: ' . implode(', ', $untouched) . '. '
			. 'Some are still handled by the schema steps (matrix_notifications and matrix_updates '
			. 'have `datos` RENAMED to `data`, a general JSON column). The final '
			. 'drop_legacy_datos_column step only touches the reformatted list above, so no table '
			. 'ever loses `datos` without its data having been migrated first.');
	}

	if (empty($ar_tables)) {
		$log('No tables to review. '
			. 'Either already migrated, or not a v6 data layout — review manually.');
	}

	// `dd_ontology` is created by the REAL phase 1 (pre_update), so in a preflight it is
	// normally absent. The per-row progress line calls label::get_label(), which queries
	// that missing table, and the engine logs ONE error per row to PHP's error_log —
	// tens of GB on a real database. The review's own findings are RETURNED (not logged),
	// so PHP error logging is suspended for the review pass only.
	// The engine reports each finding TWICE: a short line in $review->errors (returned) and a
	// detailed one via debug_log → php's error_log (the actual offending value, e.g.
	// 'component value (dd547) out of format: "2022-01-10 17:58:37"'). That detail is what you
	// want when judging an issue, but it lands in the SYSTEM log where the widget cannot show
	// it. So point error_log at a file inside the package for the duration of the review.
	$ontology_ready	= prepare_v7_dd_ontology_exists();
	$log_errors		= ini_get('log_errors');
	$error_log_prev	= ini_get('error_log');
	$engine_log		= $paths['var_dir'] . '/data_review.engine.log';

	if (!$ontology_ready) {
		// Without the ontology every row fails its label lookup: millions of meaningless
		// lines. Suppress rather than redirect — the review's own findings are RETURNED.
		$log('NOTE: table `dd_ontology` does not exist yet (the real phase 1 creates it). '
			. 'The data review still runs, but per-row label lookups fail against it, so PHP '
			. 'error logging is suspended for the review pass (it would otherwise write one '
			. 'error per row to php error_log).');
		@ini_set('log_errors', '0');
	}else{
		@file_put_contents($engine_log, '# engine detail for the data review of ' . date('c') . PHP_EOL);
		@ini_set('error_log', $engine_log);
		$log('engine-level detail for this review → ' . $engine_log);
	}

	// Structural auto-fix. ON by default: the repairs are applied IN MEMORY by
	// v6_to_v7_normalize and flow into the v7 columns during phase 2, so what this review
	// reports is exactly what the migration will do. --no-auto-fix disables them for
	// diagnosis only; it reproduces the pre-auto-fix report.
	v6_to_v7_normalize::$auto_fix = !$no_auto_fix;
	if ($no_auto_fix) {
		$log('NOTE: --no-auto-fix — structural repairs are DISABLED for this review. This is a '
			. 'diagnostic view of the raw data; the migration always runs with them enabled.');
	}

	// The machine-name step runs BEFORE reformat_matrix_data, here as in the real run. Its
	// review saves nothing, so the review pass below is armed to apply the same rules in
	// memory (set_machine_name_review): it converts the ontology records as the real run
	// will find them, and reports the machine-name findings itself (reformat_matrix_data()
	// starts by resetting the groups). Same tables as the descriptor declares.
	$machine_name_vars = prepare_v7_script_vars('migrate_ontology_machine_names');
	if (isset($machine_name_vars[0]) && is_array($machine_name_vars[0])) {
		$machine_names = v6_to_v7::migrate_ontology_machine_names($machine_name_vars[0], false); // false = no save
		$log('ontology machine names: ' . ($machine_names->msg ?? 'n/a'));
		foreach (array_slice((array)($machine_names->errors ?? []), 0, 20) as $e) {
			$log('  · ' . $e);
		}
		if ($machine_names->result === true && !v6_to_v7::set_machine_name_review($machine_name_vars[0])) {
			$log('WARNING: jer_dd could not be read; the data review converts the ontology records without their machine-name values.');
		}
	}else{
		$machine_names = null;
		$log('WARNING: the descriptor declares no migrate_ontology_machine_names step.');
	}

	$review = v6_to_v7::reformat_matrix_data($ar_tables, false); // false = no save
	v6_to_v7::set_machine_name_review(null);

	if (!$ontology_ready) {
		@ini_set('log_errors', (string)$log_errors);
	}else{
		@ini_set('error_log', (string)$error_log_prev);
	}

	// The aggregated verdict. v6_to_v7_normalize groups findings as they are produced, so
	// this is bounded no matter how large the database is; $review->errors is only the flat
	// legacy list (capped) and is no longer what the report is built from.
	$report = v6_to_v7_normalize::get_report();
	$log('data-review: ' . ($review->msg ?? 'n/a')
		. ' | auto-fixed: ' . $report->fixed
		. ' | notices: '    . $report->notices
		. ' | errors: '     . $report->errors);

	// Without `dd_ontology` no component model resolves, so EVERY value reports as an orphan
	// tipo. That is the ontology's absence (expected in a plain preflight), not a data
	// defect: count those groups once, drop them from the report, and judge the run on what
	// is left. A DEEP preflight runs after the real phase 1, so the ontology IS there and
	// these groups are then genuine.
	if (!$ontology_ready) {
		$no_model	= 0;
		$kept		= [];
		foreach ($report->groups as $group) {
			if ($group->code === 'ORPHAN_TIPO' || $group->code === 'INVALID_TIPO') {
				$no_model += $group->count;
				continue;
			}
			$kept[] = $group;
		}
		if ($no_model > 0) {
			$log('NOTE: ' . $no_model . ' unresolved-model report(s) discounted — caused by '
				. '`dd_ontology` not existing yet, not by the data. Component models can only be '
				. 'validated by a preflight run AFTER a real phase 1 (the "deep preflight").');
			$report->notices = max(0, $report->notices - $no_model);
			$report->groups  = $kept;
		}
	}

	// One grouped summary split by severity, not a wall of near-identical lines: 326 rows
	// carrying the same mechanical defect are ONE thing to know about, not 326. This block
	// is what the widget shows.
	prepare_v7_log_summary(
		$log,
		$report,
		$ontology_ready
			? 'engine-level detail (offending values) in ' . $engine_log
			: 'component models could not be checked: dd_ontology does not exist yet'
	);

	// Machine-readable sidecar for the widget, so it renders counts instead of re-parsing
	// the log text. Written on every review; absent means "no review has run".
	prepare_v7_write_review_json($paths['var_dir'] . '/data_review.json', $report, $ontology_ready);

	// The machine-name step could not run at all (not a data finding): nothing to review.
	if ($machine_names !== null && ($machine_names->result ?? false) !== true) {
		$log('PREFLIGHT FAILED: the ontology machine-name review could not run (see above).');
		exit(6);
	}

	// Only findings that need a human decision fail the preflight. Repaired values and
	// dropped-and-reported ones are informational.
	if ($report->errors > 0) {
		$log('PREFLIGHT found ' . $report->errors . ' data issue(s) needing attention'
			. ($report->fixed > 0 ? ' (' . $report->fixed . ' auto-fixed)' : '')
			. '. Review before running for real.');
		exit(6);
	}

	$log('PREFLIGHT OK'
		. ($report->fixed > 0 ? ' — ' . $report->fixed . ' issue(s) auto-fixed' : '')
		. ($report->notices > 0 ? ', ' . $report->notices . ' notice(s) to be aware of' : '')
		. '. Re-run with --yes to apply the migration.');
	exit(0);
}

// ------------------------------------------------------------------- REAL RUN
if (!$has_yes) {
	$log('Refusing to write without --yes.');
	exit(2);
}

// 4. blocking backup (unless explicitly skipped) -------------------------------
if ($skip_backup) {
	$log('Backup SKIPPED (--skip-backup). Ensure you have a current backup.');
} else {
	if (!$pg_dump_ok) {
		$log('ABORT before touching anything: the backup is mandatory and pg_dump is unusable.');
		$log('  ' . $pg_check->msg);
		$log('  Or pass --skip-backup if you already have a current backup.');
		exit(4);
	}
	$log('Backup starting (blocking pg_dump -F c) → ' . $backup_dir);
	$bk = prepare_v7_backup::run($backup_dir);
	$log('Backup: ' . $bk->msg);
	if ($bk->result !== true) {
		$log('ABORT: backup failed; migration will not proceed.');
		exit(4);
	}
}

// 5. pre_update (creates dd_ontology from jer_dd) ------------------------------
$log('pre_update_version() starting …');
$pre = update::pre_update_version();
$log('pre_update_version(): result=' . var_export($pre->result ?? false, true) . ' | ' . ($pre->msg ?? ''));
if (($pre->result ?? false) !== true) {
	if (!empty($pre->errors)) {
		foreach ($pre->errors as $e) { $log('  · ' . $e); }
	}
	$log('ABORT: pre_update failed. Restore from the backup before retrying.');
	exit(5);
}

$log('PHASE 1 done. dd_ontology provisioned.');
exit(0);


/**
* prepare_v7_log_summary
* Writes the run's FINAL, human-readable verdict: the findings grouped by what they
* actually are, split into the three things an operator does about them.
*
*   NEEDS ATTENTION  a human has to decide before migrating. These, and only these,
*                    fail the preflight.
*   NOTICES          cannot be migrated and will be dropped. Nothing to repair; the
*                    operator only has to know it is happening.
*   AUTO-FIXED       repaired automatically, in memory, by v6_to_v7_normalize. Listed
*                    so the repair is never silent, but no action is required.
*
* The flat list was unusable as a report — 326 rows carrying the same mechanical defect
* is one thing to know, not 326 lines. Grouping is done upstream on the finding's own
* identity (code + tipo + model) rather than by regex over formatted text, which also
* fixes the old summary's habit of splitting one defect across several entries because
* the section_id happened to differ.
*
* The block is delimited by markers so the widget can lift it out of the log.
*
* @param callable $log
* @param object $report - v6_to_v7_normalize::get_report()
* @param string $note   - one line of context (where the detail is, or why it is limited)
* @return void
*/
function prepare_v7_log_summary(callable $log, object $report, string $note) : void {

	$log('=== DATA REVIEW SUMMARY ===');

	if (empty($report->groups)) {
		$log('No data issues found.');
		$log($note);
		$log('=== END SUMMARY ===');
		return;
	}

	if ($report->auto_fix !== true) {
		$log('Structural auto-fix is DISABLED (--no-auto-fix): this is the raw picture, not '
			. 'what the migration would do.');
	}

	$sections = [
		['severity' => 'error',  'total' => $report->errors,  'title' => 'NEEDS ATTENTION', 'hint' => 'review before migrating'],
		['severity' => 'notice', 'total' => $report->notices, 'title' => 'NOTICES',         'hint' => 'dropped, or kept as they are and only reported; nothing to repair'],
		['severity' => 'fixed',  'total' => $report->fixed,   'title' => 'AUTO-FIXED',      'hint' => 'applied automatically during migration, no action needed']
	];

	foreach ($sections as $section) {

		$groups = array_values(array_filter(
			$report->groups,
			static fn(object $group) : bool => $group->severity === $section['severity']
		));
		if (empty($groups)) {
			continue;
		}

		$log($section['title'] . ' (' . $section['total'] . ') — ' . $section['hint']);

		$shown = 0;
		foreach ($groups as $group) {
			if ($shown >= 20) {
				$log('    … and ' . (count($groups) - $shown) . ' more kind(s); see the full log.');
				break;
			}
			$shown++;

			$log('  ' . str_pad((string)$group->count, 8, ' ', STR_PAD_LEFT) . ' × ' . $group->msg);

			$tables = array_keys((array)$group->tables);
			if (!empty($tables)) {
				$log('            tables: ' . implode(', ', $tables));
			}
			if ($group->stored_model !== null && $group->stored_model !== $group->model) {
				$log('            written as: ' . $group->stored_model
					. ' · ontology now says: ' . ($group->model !== '' ? $group->model : '(none)'));
			}
			if ($group->sample !== '') {
				$log('            sample (' . $group->sample_ref . '): ' . $group->sample);
			}

			// The records to open. Collected for NEEDS ATTENTION only — those are the ones
			// somebody has to go and look at; the other two buckets are counted, not visited.
			foreach (v6_to_v7_normalize::group_locations($group) as $location) {
				$log('            records in ' . $location->table
					. ' · section_tipo ' . $location->section_tipo
					. ' · section_id: ' . implode(', ', $location->ids)
					. ($location->truncated ? ' … (list capped)' : ''));
			}
			foreach (v6_to_v7_normalize::group_sql($group) as $sql) {
				$log('            ' . $sql);
			}
		}
	}

	if ($report->errors_overflow > 0) {
		$log('NOTE: the flat error list was capped; ' . $report->errors_overflow
			. ' entr(ies) are counted above but not listed individually.');
	}

	$log($note);
	$log('=== END SUMMARY ===');
}//end prepare_v7_log_summary



/**
* prepare_v7_write_review_json
* Machine-readable twin of the summary block, for the widget.
*
* The widget used to re-parse the log text to find the verdict, which meant every
* wording change was a client-side breakage waiting to happen. Writing the counts once,
* here, lets the widget render chips from data and keep the log purely as prose.
*
* Best-effort: a failed write is not worth failing a preflight over, so it is logged
* nowhere and simply leaves the widget on its text-only path.
*
* @param string $file
* @param object $report
* @param bool $ontology_ready
* @return bool
*/
function prepare_v7_write_review_json(string $file, object $report, bool $ontology_ready) : bool {

	$payload = [
		'generated'			=> date('c'),
		'auto_fix'			=> $report->auto_fix,
		'ontology_ready'	=> $ontology_ready,
		'fixed'				=> $report->fixed,
		'notices'			=> $report->notices,
		'errors'			=> $report->errors,
		'errors_overflow'	=> $report->errors_overflow,
		'groups'			=> array_map(
			static fn(object $group) : array => [
				'code'			=> $group->code,
				'severity'		=> $group->severity,
				'tipo'			=> $group->tipo,
				'model'			=> $group->model,
				'stored_model'	=> $group->stored_model,
				'count'			=> $group->count,
				'tables'		=> $group->tables,
				'msg'			=> $group->msg,
				'sample'		=> $group->sample,
				'sample_ref'	=> $group->sample_ref,
				// the records to review, and the statements that fetch them (populated for
				// severity 'error' only — see v6_to_v7_normalize::LOCATIONS_CAP)
				'locations'		=> v6_to_v7_normalize::group_locations($group),
				'sql'			=> v6_to_v7_normalize::group_sql($group)
			],
			$report->groups
		)
	];

	$json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

	return $json !== false && @file_put_contents($file, $json) !== false;
}//end prepare_v7_write_review_json


/**
* prepare_v7_dd_ontology_exists
* True when the v7 ontology table is already present (i.e. a real phase 1 has run).
* @return bool
*/
function prepare_v7_dd_ontology_exists() : bool {

	try {
		$res = matrix_db_manager::exec_search("SELECT to_regclass('public.dd_ontology') AS t", [], false);
		if ($res) {
			$row = pg_fetch_assoc($res);
			return !empty($row['t']);
		}
	} catch (\Throwable $e) {
		// unknown → assume absent, the caller only uses this to reduce log noise
	}

	return false;
}//end prepare_v7_dd_ontology_exists


/**
* prepare_v7_discover_datos_tables
* Discover matrix tables that still carry the legacy v6 `datos` column — the
* exact set reformat_matrix_data() must process. Self-contained so the review
* does not depend on the private $ar_tables list inside updates.php.
* @return array<int,string>
*/
function prepare_v7_discover_datos_tables() : array {

	$sql = "SELECT table_name
		FROM information_schema.columns
		WHERE table_schema = 'public'
		  AND column_name  = 'datos'
		  AND table_name LIKE 'matrix%'
		  AND table_name <> 'matrix_time_machine'
		ORDER BY table_name";
	$out = [];
	try {
		$res = matrix_db_manager::exec_search($sql, [], false);
		if ($res) {
			while ($row = pg_fetch_assoc($res)) {
				$out[] = $row['table_name'];
			}
		}
	} catch (\Throwable $e) {
		// leave empty on error; caller logs the empty set
	}

	return $out;
}//end prepare_v7_discover_datos_tables
