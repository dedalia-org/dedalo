<?php declare(strict_types=1);
/**
* ENGINE_BOOT — boot the BUNDLED v7 engine for a migration phase (CLI only).
*
* Every migration phase (preflight / pre_update / update) runs in its own PHP
* process and starts by requiring this file. It:
*   1. resolves the bundled engine root,
*   2. requires <engine>/config/bootstrap.php (loads the whole v7 engine, its
*      autoloader, and the config from <engine>/../private/.env — which bootstrap
*      auto-migrates from the v6 config files placed in <engine>/config/),
*   3. establishes a CLI DEDALO_SUPERUSER session (same pattern as
*      tools/tool_common/cli/export_register.php),
*   4. loads the package helper libs.
*
* Engine-root resolution (first hit wins):
*   a. env PREPARE_V7_ENGINE_ROOT      (explicit override; for testing against another engine)
*   b. <package>/engine                (the bundled engine — the normal, self-contained case)
*
* There is deliberately NO third fallback. The engine ships INSIDE this package: the
* migration must run from a plain v6 checkout, never resolving against some other
* repository that happens to sit next to it.
*
* @package Dédalo
* @subpackage close_v6_prepare_v7
* @return array{engine_root:string, package_root:string, var_dir:string}
*/

if (PHP_SAPI !== 'cli') {
	fwrite(STDERR, "prepare_v7 phases must be run from the command line\n");
	exit(2);
}

/**
* prepare_v7_resolve_paths
* @return array{engine_root:string, package_root:string, var_dir:string}
*/
function prepare_v7_resolve_paths() : array {

	// this file lives at <package>/run/lib/engine_boot.php
	$package_root = dirname(__DIR__, 2);

	$env_root = getenv('PREPARE_V7_ENGINE_ROOT');
	if (is_string($env_root) && $env_root !== '' && is_file($env_root . '/config/bootstrap.php')) {
		$engine_root = rtrim($env_root, DIRECTORY_SEPARATOR);
	} elseif (is_file($package_root . '/engine/config/bootstrap.php')) {
		$engine_root = $package_root . '/engine';                 // the bundled engine
	} else {
		fwrite(STDERR, "The bundled engine is missing: expected "
			. $package_root . "/engine/config/bootstrap.php\n"
			. "This package ships its own engine; do not point it at another install.\n");
		exit(2);
	}

	$var_dir = $package_root . '/var';

	return [
		'engine_root'  => $engine_root,
		'package_root' => $package_root,
		'var_dir'      => $var_dir,
	];
}//end prepare_v7_resolve_paths


/**
* prepare_v7_fail_loud
* Makes a phase FAIL VISIBLY. Call it right after the phase resolves its log file.
*
* The engine installs its own exception handler (core/base/class.Error.php), and PHP
* terminates with exit code **0** once a user exception handler returns — so an uncaught
* Throwable inside a phase looked exactly like success to the runner: no completion lines,
* no error, "exited with code 0", "Preflight PASSED". This installs a handler that chains
* the engine's (so its logging still happens), records the throwable in the phase log and
* exits 9. A real fatal (E_ERROR, OOM …) already exits non-zero, but is recorded here too,
* because the engine routes it to php's error_log, not to our log.
*
* @param string $log_file
* @param string $tag - phase tag used in the log lines, e.g. 'phase1'
* @return void
*/
function prepare_v7_fail_loud(string $log_file, string $tag) : void {

	$emit = static function(string $line) use ($log_file, $tag) : void {
		@file_put_contents($log_file, date('c') . ' [' . $tag . '] ' . $line . PHP_EOL, FILE_APPEND | LOCK_EX);
		fwrite(STDERR, $line . PHP_EOL);
	};

	// capture the engine's handler, then install ours on top
	$previous = set_exception_handler(static function() : void {});
	set_exception_handler(static function(\Throwable $e) use ($previous, $emit) : void {
		if (is_callable($previous)) {
			try { $previous($e); } catch (\Throwable $ignored) {} // engine logging is best-effort
		}
		$emit('UNCAUGHT ' . get_class($e) . ': ' . $e->getMessage());
		$emit('  at ' . $e->getFile() . ':' . $e->getLine());
		exit(9);
	});

	register_shutdown_function(static function() use ($emit) : void {
		$err = error_get_last();
		if ($err !== null && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true)) {
			$emit('FATAL: ' . $err['message']);
			$emit('  at ' . $err['file'] . ':' . $err['line']);
		}
	});
}//end prepare_v7_fail_loud


/**
* prepare_v7_migration_tables
* The tables the REAL run will reformat, read from the migration descriptor itself
* (run_scripts → reformat_matrix_data → script_vars[0]).
*
* The preflight must review exactly this list: reviewing more is not "extra safety",
* it crashes — e.g. matrix_notifications has no section_tipo column at all, and
* v6_to_v7::process_matrix_row_data() takes section_tipo as a non-nullable string.
*
* @return array<int,string> - empty when the descriptor does not declare the step
*/
function prepare_v7_migration_tables() : array {

	if (!class_exists('update')) {
		return [];
	}

	$updates = update::get_updates();
	$first   = array_key_first((array)$updates);
	if ($first === null) {
		return [];
	}

	foreach ((array)($updates->$first->run_scripts ?? []) as $script) {
		if (($script->script_method ?? '') === 'reformat_matrix_data') {
			$vars = (array)($script->script_vars ?? []);
			if (isset($vars[0]) && is_array($vars[0])) {
				return array_values($vars[0]);
			}
		}
	}

	return [];
}//end prepare_v7_migration_tables


/**
* prepare_v7_script_vars
* The script_vars of one run_scripts step of the migration descriptor, by method name,
* so the preflight reviews a step with exactly the arguments the real run passes.
*
* @param string $method - v6_to_v7 method name, e.g. 'migrate_ontology_machine_names'
* @return array|null - null when the descriptor does not declare the step
*/
function prepare_v7_script_vars(string $method) : ?array {

	if (!class_exists('update')) {
		return null;
	}

	$updates = update::get_updates();
	$first   = array_key_first((array)$updates);
	if ($first === null) {
		return null;
	}

	foreach ((array)($updates->$first->run_scripts ?? []) as $script) {
		if (($script->script_method ?? '') === $method) {
			return (array)($script->script_vars ?? []);
		}
	}

	return null;
}//end prepare_v7_script_vars


/**
* prepare_v7_boot_engine
* Boots the bundled engine and a CLI superuser session. Returns resolved paths.
* @return array{engine_root:string, package_root:string, var_dir:string}
*/
function prepare_v7_boot_engine() : array {

	$paths = prepare_v7_resolve_paths();

	// Runtime dirs the bundled engine expects NEXT TO its root (paths.* are DERIVED from
	// the engine root: cache_path = <engine>/../cache). Without cache/ every label lookup
	// logs "base_path is not writable" — once per row during the data review.
	foreach ([$paths['package_root'] . '/cache', $paths['var_dir']] as $dir) {
		if (!is_dir($dir)) {
			@mkdir($dir, 0775, true);
		}
	}

	require_once $paths['engine_root'] . '/config/bootstrap.php';

	// The migration orchestrator + upgrade classes are NOT autoloaded (in the app
	// they are include_once'd by the caller — e.g. the update_data_version widget).
	// Require the entry class explicitly; update::get_updates() then pulls in
	// updates.php, class.v6_to_v7.php and class.dataframe_v7_migration.php.
	require_once DEDALO_CORE_PATH . '/base/update/class.update.php';
	require_once DEDALO_CORE_PATH . '/base/upgrade/class.v6_to_v7.php';

	// No activity logging during a migration. The v7 logger writes matrix_activity with the
	// v7 typed columns, but that table is still v6 (`datos`) until phase 2 rewrites it — every
	// deferred log line fails with 'column "data" of relation "matrix_activity" does not exist'.
	// update::pre_update_version()/update_version() already disable it internally for the same
	// reason; do it for the whole phase so the preflight and the deep preflight are quiet too.
	if (class_exists('logger_backend_activity')) {
		logger_backend_activity::$enable_log = false;
	}

	// CLI superuser context (shell access already implies full trust; same model
	// as tools/tool_common/cli/export_register.php and core/rag/cli/*).
	if (!class_exists('login') || login::is_logged() !== true) {
		$_SESSION['dedalo']['auth']['user_id']		= DEDALO_SUPERUSER;
		$_SESSION['dedalo']['auth']['username']		= 'cli-prepare-v7';
		$_SESSION['dedalo']['auth']['is_logged']	= 1;
		$_SESSION['dedalo']['auth']['salt_secure']	= bin2hex(random_bytes(16));
	}

	// package helper libs (need engine constants/classes already loaded)
	require_once __DIR__ . '/blocking_backup.php';
	require_once __DIR__ . '/version_gate.php';

	if (!is_dir($paths['var_dir'])) {
		@mkdir($paths['var_dir'], 0775, true);
	}

	return $paths;
}//end prepare_v7_boot_engine
