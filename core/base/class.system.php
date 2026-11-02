<?php declare(strict_types=1);
/**
* SYSTEM
* Handle information and checks about the Dédalo system
* like installation operative system and libraries.
*/
class system {



	/**
	* GET_INFO
	* Loads composer lib 'Linfo' and gets the main data for the system
	* // @use linfo
	* linfo lib installed via composer
	* @see https://github.com/jrgp/linfo
	* @return object $info
	*/
	public static function get_info() : object {

		static $info_instance;
		if (isset($info_instance)) {
			return $info_instance;
		}

		include_once DEDALO_LIB_PATH . '/vendor/autoload.php';
		$info_instance = new \Linfo\Linfo;


		return $info_instance;
	}//end get_info



	/**
	* GET_RAM
	* Get the system physical memory installed in the system
	* in Gigabytes
	* @return int $total_gb
	*/
	public static function get_ram() : int {

		$info		= system::get_info();
		$ram_info	= $info->getRam();
		$total_gb	= intval( round((int)$ram_info['total'] / (1024 * 1024 * 1024), 0) );


		return $total_gb;
	}//end get_ram



	/**
	* GET_MHZ
	* Get the system processor clock frequency if is available
	* in Mega Hertz. If is not resolved, null is returned.
	* like: 3600
	* @return int|null $total_mhz
	*/
	public static function get_mhz() : ?int {

		$info		= system::get_info();
		$cpu_info	= $info->getCPU();

		// sample data
		// $cpu_info = json_decode('[
		//   {
		// 	"Vendor": "GenuineIntel",
		// 	"Model": "Intel(R) Xeon(R) CPU E3-1230 v6 @ 3.50GHz",
		// 	"MHz": "3500.000"
		//   },
		//   {
		// 	"Model": "Intel(R) Xeon(R) CPU E3-1230 v6 @ 3.50GHz",
		// 	"Vendor": "GenuineIntel",
		// 	"MHz": "3500.000"
		//   }
		// ]');

		preg_match_all('/.*"MHz": "([0-9]+)\.[0-9]+".*/', to_string($cpu_info), $output_array);

		$match_list = $output_array[1] ?? [];
		if (!empty($match_list)) {
			// max value
			$total_mhz = intval( max($match_list) );
		}


		return $total_mhz ?? null;
	}//end get_mhz



	/**
	* TEST_PHP_VERSION_SUPPORTED
	* Test if PHP version is supported
	* @param string $minimum_php_version = '8.1.0'
	* @return bool
	*/
	public static function test_php_version_supported(string $minimum_php_version='8.1.0') : bool {

		if (version_compare(PHP_VERSION, $minimum_php_version) >= 0) {
			return true;
		}else{
			debug_log(__METHOD__
				." This PHP version (".PHP_VERSION.") is not supported ! Please update your PHP to $minimum_php_version or higher ASAP "
				, logger::ERROR
			);
			return false;
		}
	}//end test_php_version_supported



	/**
	* TEST_APACHE_VERSION_SUPPORTED
	* Test if Apache version is supported
	* @param string $minimum_version = '2.4.6'
	* @return bool
	*/
	public static function test_apache_version_supported(string $minimum_version='2.4.6') : bool {

		$version = system::get_apache_version();

		if (empty($version)) {
			return false;
		}

		if (version_compare(trim($version), trim($minimum_version)) >= 0) {
			return true;
		}else{
			debug_log(__METHOD__
				." This Apache version (".$version.") is not supported ! Please update your Apache to $minimum_version or higher ASAP "
				, logger::ERROR
			);
			return false;
		}
	}//end test_apache_version_supported



	/**
	* TEST_POSTGRESQL_VERSION_SUPPORTED
	* Test if postgresql version is supported
	* @param string $minimum_version = '16.1'
	* @return bool
	*/
	public static function test_postgresql_version_supported(string $minimum_version='16.1') : bool {

		$version = system::get_postgresql_version();

		if (empty($version)) {
			return false;
		}

		if (version_compare(trim($version), trim($minimum_version)) >= 0) {
			return true;
		}else{
			debug_log(__METHOD__
				." This postgresql version (".$version.") is not supported ! Please update your postgresql to $minimum_version or higher ASAP "
				, logger::ERROR
			);
			return false;
		}
	}//end test_postgresql_version_supported



	/**
	* GET_APACHE_VERSION
	* Get the Apache daemon version
	* @return string $version
	*/
	public static function get_apache_version() : string {

		$binary_base_path = get_base_binary_path();

		$commands = [];

		$name		= 'httpd';
		// With full binary path
		$cmd		= $binary_base_path . '/'.$name.' -v | sed -n "s/Server version: Apache\/\([-0-9.]*\).*/\1/p;" ';
		$commands[] = $cmd;
		$version	= shell_exec($cmd);
		if (empty($version)) {
			// Without binary path
			$cmd		= $name.' -v | sed -n "s/Server version: Apache\/\([-0-9.]*\).*/\1/p;" ';
			$commands[] = $cmd;
			$version	= shell_exec($cmd);
		}

		if (empty($version)) {
			$name		= 'apache2';
			$cmd		= $binary_base_path . '/'.$name.' -v | sed -n "s/Server version: Apache\/\([-0-9.]*\).*/\1/p;" ';
			$version	= shell_exec($cmd);
			if (empty($version)) {
				$cmd		= $name.' -v | sed -n "s/Server version: Apache\/\([-0-9.]*\).*/\1/p;" ';
				$commands[] = $cmd;
				$version	= shell_exec($cmd);
			}
		}

		if (empty($version)) {
			debug_log(__METHOD__
				." Apache (httpd or apache2) not found " . PHP_EOL
				.' commands: ' . json_encode($commands, JSON_PRETTY_PRINT) . PHP_EOL
				.' binary_base_path: ' . $binary_base_path
				, logger::ERROR
			);
			return '';
		}


		return trim($version);
	}//end get_apache_version



	/**
	* GET_POSTGRESQL_VERSION
	* Get the postgresql daemon version
	* @return string $version
	*/
	public static function get_postgresql_version() : string {

		$binary_base_path = get_base_binary_path();

		$name		= 'pg_config';
		$cmd		= $binary_base_path . '/'.$name.' --version | sed -n "s/PostgreSQL \([-0-9.]*\).*/\1/p;" ';
		$version	= shell_exec($cmd);
		if (empty($version)) {
			$cmd		= $name.' --version | sed -n "s/PostgreSQL \([-0-9.]*\).*/\1/p;" ';
			$version	= shell_exec($cmd);
		}

		// try using client psql
		if (empty($version)) {
			$name		= 'psql';
			$cmd		= $name.' --version | sed -n "s/psql (PostgreSQL) \([-0-9.]*\).*/\1/p;" ';
			$version	= shell_exec($cmd);
		}

		if (empty($version)) {
			debug_log(__METHOD__
				." PostgreSQL ($name) not found " . PHP_EOL
				.' command: ' . $cmd . PHP_EOL
				.' binary_base_path: ' . $binary_base_path
				, logger::ERROR
			);
			return '';
		}


		return trim($version);
	}//end get_postgresql_version



	/**
	* GET_MYSQL_SERVER
	* Get the MariaDB/MySQL daemon version
	* Usually, MariaDB is used, but sometimes a MySQL database could be
	* used too. Try both in cascade
	* @return string $version
	*/
	public static function get_mysql_server() : ?string {

		$binary_base_path = get_base_binary_path();

		// mariadb try
			$cmd		= 'mariadb -V';
			$version	= shell_exec($cmd);
			if (empty($version)) {
				$cmd		= $binary_base_path . '/'. $cmd;
				$version	= shell_exec($cmd);
			}

			if (!empty($version)) {
				return 'mariadb';
			}

		// mysql try
			$cmd		= 'mysql -V';
			$version	= shell_exec($cmd);
			if (empty($version)) {
				$cmd		= $binary_base_path . '/'. $cmd;
				$version	= shell_exec($cmd);
			}

			if (!empty($version)) {
				return 'mysql';
			}


		return null;
	}//end get_mysql_server



	/**
	* GET_MYSQL_VERSION
	* Get the MYSQL daemon version
	* @param string|null $mysql_server = null
	* 	mariadb|mysql|null
	* @return string|null $version
	*/
	public static function get_mysql_version( ?string $mysql_server=null ) : ?string {

		// server: mariadb|mysql|null
		$mysql_server = $mysql_server ?? system::get_mysql_server();
		if (empty($mysql_server)) {
			return null;
		}

		$name		= $mysql_server;
		$cmd		= $name.' -V | sed -n "s/.*'.$name.' from \([0-9.]*\).*/\1/p;" ';
		$version	= shell_exec($cmd);

		// try with binary path
		if (empty($version)) {
			$binary_base_path	= get_base_binary_path();
			$cmd				= $binary_base_path . '/'. $cmd;
			$version			= shell_exec($cmd);
		}

		if (empty($version)) {
			return null;
		}


		return trim($version);
	}//end get_mysql_version



	/**
	* GET_PHP_MEMORY
	* Get PHP memory limit in gigabytes
	* @return int $gigabytes
	*/
	public static function get_php_memory() : int {

		$memory_limit = ini_get('memory_limit') ?? 0;
		if (empty($memory_limit)) {
			return 0;
		}

		$bytes = system::return_bytes( $memory_limit );

		$gigabytes_float = $bytes / (1024 * 1024 * 1024);

		$gigabytes = intval( round($gigabytes_float, 0) );


		return $gigabytes;
	}//end get_php_memory



	/**
	* RETURN_BYTES
	* Converts shorthand memory notation value to bytes
	* From http://php.net/manual/en/function.ini-get.php
	* @param string $val
	* 	Memory size shorthand notation string
	* @return int $val
	*/
	public static function return_bytes( string $val ) : int {
		$val	= trim($val);
		$last	= strtolower($val[strlen($val)-1]);
		$size	= (int)substr($val, 0, -1);
		switch($last) {
			// The 'G' modifier is available since PHP 5.1.0
			case 'g':
				$size *= (1024 * 1024 * 1024);
				break;
			case 'm':
				$size *= (1024 * 1024);
				break;
			case 'k':
				$size *= 1024;
				break;
		}

		return $size;
	}//end return_bytes



	/**
	* GET_PHP_USER_INFO
	* Resolves current PHP user
	* @return object|null $info
	*/
	public static function get_php_user_info() : ?object {

		try {
			if (function_exists('posix_getpwuid') && function_exists('posix_geteuid')) {
				$ar_info = posix_getpwuid(posix_geteuid());
			}else{
				$name			= get_current_user();
				$current_user	= trim(shell_exec('whoami'));
				$ar_info = [
					'name'			=> $name,
					'current_user'	=> $current_user
				];
			}

			// cast to object
			$info = (object)$ar_info;

		} catch (Exception $e) {
			debug_log(__METHOD__
				." Exception:".$e->getMessage()
				, logger::ERROR
			);
		}

		return $info ?? null;
	}//end get_php_user_info



	/**
	* GET_ERROR_LOG_PATH
	* Resolves current PHP error log file path
	* @return string|null $error_path
	*/
	public static function get_error_log_path() : ?string {

		try {

			$error_path = ini_get('error_log');

		} catch (Exception $e) {
			debug_log(__METHOD__
				." Exception:".$e->getMessage()
				, logger::ERROR
			);
		}

		return $error_path ?? null;
	}//end get_error_log_path



	/**
	* CHECK_GD_LIB
	* Returns true if the PHP GD lib is installed, false if not
	* @see https://www.php.net/manual/en/book.image.php
	* @see https://www.php.net/manual/en/function.extension-loaded.php
	* @return bool
	*/
	public static function check_gd_lib() : bool {

		return extension_loaded('gd');
	}//end check_gd_lib



	/**
	* CHECK_SESSIONS_PATH
	* Checks if Dédalo sessions path is set and available
	* constant 'DEDALO_SESSIONS_PATH' is defined in config.php
	* @see config.php
	* @return bool
	*/
	public static function check_sessions_path() : bool {

		if (!defined('DEDALO_SESSIONS_PATH')) {
			return false;
		}

		$dir_exists = create_directory(DEDALO_SESSIONS_PATH, 0750);
		if( $dir_exists===true ){
			return true;
		}


		return false;
	}//end check_sessions_path



	/**
	* DELETE_OLD_SESSIONS_FILES
	* Cleans old files (sessions and caches) from
	* 'DEDALO_SESSIONS_PATH' directory
	* Note that each Dédalo process creates an individual process log file.
	* @return bool
	*/
	public static function delete_old_sessions_files() : bool {

		if (!system::check_sessions_path()) {
			debug_log(__METHOD__
				. " Unable to delete session files. Sessions directory is unavailable"
				. to_string()
				, logger::DEBUG
			);
			return false;
		}

		$cache_life	= 4 * 24 * 60 * 60; // caching time, in seconds - 2 days -
		$files		= glob(DEDALO_SESSIONS_PATH . '/*');
		foreach($files as $file) {

			// time in seconds (number of seconds since the Unix Epoch (January 1 1970 00:00:00 GMT))
			$date_now		= time();
			$date_modified	= filemtime($file);

			if ( ($date_now - $date_modified) >= $cache_life ) {
				$deleted = unlink($file);
				if( !$deleted ) {
					debug_log(__METHOD__
						. " Error deleting cache file " . PHP_EOL
						. ' file: ' . to_string($file)
						, logger::ERROR
					);
					continue;
				}

				debug_log(__METHOD__
					. " Deleted cache file " . PHP_EOL
					. ' file: ' . to_string($file) .PHP_EOL
					. ' date_modified: ' . to_string($date_modified)
					, logger::WARNING
				);
			}
		}

		return true;
	}//end delete_old_sessions_files



	/**
	* CHECK_BACKUP_PATH
	* Checks if Dédalo backup path is set and available
	* constant 'DEDALO_BACKUP_PATH' is defined in config.php
	* Note that this directory contains various types of backups:
	* /db, /ontology, /mysql, /temp
	* @see config.php
	* @return bool
	*/
	public static function check_backup_path() : bool {

		if (!defined('DEDALO_BACKUP_PATH')) {
			return false;
		}

		$dir_exists = create_directory(DEDALO_BACKUP_PATH, 0750);
		if( $dir_exists===true ){
			return true;
		}


		return false;
	}//end check_backup_path



	/**
	* CHECK_DIRECTORY
	* Generic function to check if Dédalo directory is set and available.
	* If the folder does not exist, try to create it.
	* @return bool
	*/
	public static function check_directory( string $name ) : bool {

		$dir_exists = create_directory($name, 0750);
		if( $dir_exists===true ){
			return true;
		}


		return false;
	}//end check_directory



	/**
	* CHECK_PGPASS_FILE
	* Check if PostgreSQL file '.pgpass' already exists
	* and have the correct permissions: '0600'
	* If file exists but permissions are not the expected,
	* it will try to fix the file to correct value
	* @see https://www.postgresql.org/docs/current/libpq-pgpass.html
	* @return bool
	*/
	public static function check_pgpass_file() : bool {

		$php_user_home	= getenv('HOME');
		$path			= $php_user_home . '/.pgpass';

		if (!file_exists($path)) {
			return false;
		}

		$file_permissions = substr(sprintf('%o', fileperms($path)), -4);
		if ($file_permissions!=='0600') {
			// Try to change it
			if(true===chmod($path, 0600)){
				debug_log(__METHOD__
					." Changed permissions of file .pgpass to 0600 "
					, logger::WARNING
				);
				return true;
			}

			return false;
		}

		return true;
	}//end check_pgpass_file



	/**
	* CHECK_CURL
	* Checks if curl is installed and available for PHP
	* @return bool
	*/
	public static function check_curl() : bool{

		if(!function_exists('curl_init') || !function_exists('curl_version')) {

			return false;
		}

		return true;
	}//end check_curl



	/**
	* REMOVE_OLD_CHUNK_FILES
	* Delete chunk files older than x time
	* If errors occurred in upload files process, chunk files could be
	* stored and not deleted. use this function to clean old chunks
	* Note that chunk are used only if config 'DEDALO_UPLOAD_SERVICE_CHUNK_FILES' is set
	* @see config.php
	* @return bool
	*/
	public static function remove_old_chunk_files() : bool {

		$ar_folder = DEDALO_AV_AR_QUALITY;
		foreach ($ar_folder as $quality) {

			$folder_path = DEDALO_MEDIA_PATH . DEDALO_AV_FOLDER . '/'. $quality;

			// get chunk files (.blob)
				$files = glob( $folder_path.'/*.blob' );
				if (empty($files)) {
					continue;
				}

			// folder_path_to_delete
				$folder_path_to_delete = $folder_path .'/to_delete';
				if (!system::check_directory($folder_path_to_delete)) {
					debug_log(__METHOD__
						. " Ignored quality. Unable to create directory " . PHP_EOL
						. 'quality: ' . to_string($quality) . PHP_EOL
						. 'folder_path_to_delete: ' . to_string($folder_path_to_delete)
						, logger::ERROR
					);
					continue;
				}

			// iterate found files checking the date
				$max_preservation_hours = 12;
				foreach ($files as $file) {

					$modification_time_secs	= filemtime($file);
					$current_time_secs		= time();
					$difference_in_hours	= round( ($current_time_secs/3600) - round($modification_time_secs/3600), 0 );
					if ($difference_in_hours >= $max_preservation_hours) {

						$target = $folder_path_to_delete . '/' . pathinfo($file)['basename'];

						// move file to directory 'to_delete'
						$rename_result = rename($file, $target);
						if ($rename_result===false) {
							debug_log(__METHOD__
								. " Error on move file " . PHP_EOL
								. ' file: ' .$file . PHP_EOL
								. ' target: ' .$target
								, logger::ERROR
							);
						}else{
							debug_log(__METHOD__
								. " Moved file successfully " . PHP_EOL
								. ' file:   ' . $file . PHP_EOL
								. ' target: ' . $target
								, logger::DEBUG
							);
						}
					}
				}//end foreach ($files as $file)
		}//end foreach ($ar_folder as $quality)

		// upload tmp dir. Chunks and partial joins left by failed or abandoned chunked uploads
			if (defined('DEDALO_UPLOAD_TMP_DIR')) {
				$max_preservation_secs	= 24 * 3600;
				$tmp_files				= array_merge(
					glob(DEDALO_UPLOAD_TMP_DIR . '/*/*/*.blob') ?: [],
					glob(DEDALO_UPLOAD_TMP_DIR . '/*/*/part_*') ?: []
				);
				foreach ($tmp_files as $file) {
					if (is_file($file) && (time() - filemtime($file)) >= $max_preservation_secs) {
						if (!unlink($file)) {
							debug_log(__METHOD__
								. " Error on delete old upload tmp file " . PHP_EOL
								. ' file: ' .$file
								, logger::ERROR
							);
						}
					}
				}
			}


		return true;
	}//end remove_old_chunk_files



	/**
	* GET_DISK_INFO
	* Collects information about the system disks
	* @return string $disk_info
	*/
	public static function get_disk_info() : string {

		try {

			switch (PHP_OS) {

				case 'Darwin':
					$ar_info = [];

					// general info list
					$list = shell_exec('/usr/sbin/diskutil list');
					$ar_info[] = $list ;

					// detailed info of each disk
					preg_match_all('/\/dev\/disk[0-9]+/', $list, $output_array);
					foreach ($output_array[0] as $disk_path) {
						$ar_info[] = shell_exec('/usr/sbin/diskutil info '.$disk_path);
					}

					// result
					$result = implode('<hr>', array_map(function($el){
						return trim($el);
					}, $ar_info));
					break;

				case 'Linux':
				default:
					$cmd = 'lsblk -io NAME,TYPE,SIZE,MOUNTPOINT,FSTYPE,MODEL';
					$result = shell_exec($cmd);
					break;
			}

			$disk_info = empty($result) ? 'Info unavailable' : str_replace("\n", '<br />', $result);

		} catch (Exception $e) {

			$disk_info = 'Info unavailable. Exception: ' . $e->getMessage();
		}


		return $disk_info;
	}//end get_disk_info



	/**
	* GET_DISK_FREE_SPACE
	* Get the main disk free space in megabytes
	* ! Note: This function will not work on remote files as the file to be
	* examined must be accessible via the server's filesystem.
	* @return int|null $megabytes
	*/
	public static function get_disk_free_space() : ?int {

		$free_space = disk_free_space('/');
		if (!$free_space) {
			return null;
		}

		$megabytes = intval($free_space / 1024 / 1024);

		return $megabytes;
	}//end get_disk_free_space



}//end class system
