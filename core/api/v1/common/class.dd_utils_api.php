<?php declare(strict_types=1);
/**
* DD_UTILS_API
* Manage API REST data with Dédalo
*
*/
final class dd_utils_api {



	/**
	* GET_LOGIN_CONTEXT
	* This function is not used in normal login behavior (login is called directly in start API).
	* It could be called when the instance of the login has been build with autoload in true.
	* This function could be called by external processes as install to get the context of the login
	* and to create the login instance
	* Login only need context, it not needed data to render.
	* @param object $rqo
	* {
	*	action	: 'get_login_context',
	*	dd_api	: 'dd_utils_api',
	*	source	: source
	* }
	* @return object $response
	*/
	public static function get_login_context(object $rqo) : object {

		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Error. Request failed ['.__FUNCTION__.']';

		$login = new login();

		// login JSON
			$get_json_options = new stdClass();
				$get_json_options->get_context	= true;
				$get_json_options->get_data		= false;
			$login_json = $login->get_json($get_json_options);

		// context add
			$context = $login_json->context;

		// response
			$response->result	= $context;
			$response->msg		= 'OK. Request done';


		return $response;
	}//end get_login_context



	/**
	* GET_INSTALL_CONTEXT
	* This function is an alias of get_element_context and does not need to login before
	* @param object $rqo
	* {
	*	action	: 'get_install_context',
	*	dd_api	: 'dd_utils_api',
	*	source	: source
	*  }
	* @return object $response
	*/
	public static function get_install_context(object $rqo) : object {

		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Error. Request failed ['.__FUNCTION__.']';

		$install = new install();

		// install JSON
			$get_json_options = new stdClass();
				$get_json_options->get_context	= true;
				$get_json_options->get_data		= false;
			$install_json = $install->get_json($get_json_options);

		// context add
			$context = $install_json->context;

		// response
			$response->result	= $context;
			$response->msg		= 'OK. Request done';


		return $response;
	}//end get_install_context



	/**
	* DEDALO_VERSION (UNUSED !)
	* Use environment page_globals instead !
	* @param object $rqo
	* @return object $response
	*/
		// public static function dedalo_version(object $rqo) : object {

		// 	session_write_close();

		// 	$response = new stdClass();
		// 		$response->result	= false;
		// 		$response->msg		= 'Error. Request failed ['.__FUNCTION__.']';


		// 	$response->result = (object)[
		// 		'version' 	=>	DEDALO_VERSION,
		// 		'build'		=>	DEDALO_BUILD
		// 	];
		// 	$response->msg 	  = 'OK. Request done';


		// 	return $response;
		// }//end dedalo_version




	/**
	* GET_SYSTEM_INFO
	* @param object $rqo
	* @return object response
	*/
	public static function get_system_info(object $rqo) : object {

		$response = new stdClass();
			$response->result 	= false;
			$response->msg 		= 'Error. Request failed';

		// Returns a file size limit in bytes based on the PHP upload_max_filesize
		// and post_max_size
		function file_upload_max_size() {
		  static $max_size = -1;

		  if ($max_size < 0) {
			// Start with post_max_size.
			$post_max_size = parse_size(ini_get('post_max_size'));
			if ($post_max_size > 0) {
			  $max_size = $post_max_size;
			}

			// If upload_max_size is less, then reduce. Except if upload_max_size is
			// zero, which indicates no limit.
			$upload_max = parse_size(ini_get('upload_max_filesize'));
			if ($upload_max > 0 && $upload_max < $max_size) {
			  $max_size = $upload_max;
			}
		  }
		  return $max_size;
		}

		function parse_size($size) {
		  $unit = preg_replace('/[^bkmgtpezy]/i', '', $size); // Remove the non-unit characters from the size.
		  $size = preg_replace('/[^0-9\.]/', '', $size); // Remove the non-numeric characters from the size.
		  if ($unit) {
			// Find the position of the unit in the ordered string which is the power of magnitude to multiply a kilobyte by.
			return round( floatval($size) * pow(1024, stripos('bkmgtpezy', $unit[0])));
		  }
		  else {
			return round( floatval($size) );
		  }
		}

		$upload_tmp_dir = ini_get('upload_tmp_dir');

		// system_info
			$system_info = new stdClass();
				$system_info->max_size_bytes				= file_upload_max_size();
				$system_info->sys_get_temp_dir				= sys_get_temp_dir();
				$system_info->upload_tmp_dir				= $upload_tmp_dir;
				$system_info->upload_tmp_perms				= fileperms($upload_tmp_dir);
				$system_info->session_cache_expire			= (int)ini_get('session.cache_expire');
				$system_info->upload_service_chunk_files	= DEDALO_UPLOAD_SERVICE_CHUNK_FILES;
				$system_info->pdf_ocr_engine				= defined('PDF_OCR_ENGINE') ? true : false;

		// response
			$response->result 	= $system_info;
			$response->msg 		= 'OK. Request done';

		return $response;
	}//end get_system_info




	/**
	* BUILD_STRUCTURE_CSS **** DEPRECATED ! ****
	* @param object $rqo
	* @return object $response
	*/
		// public static function build_structure_css(object $rqo) : object {

		// 	// session_write_close();

		// 	$response = new stdClass();
		// 		$response->result	= false;
		// 		$response->msg		= 'Error. Request failed ['.__FUNCTION__.']';


		// 	$response->result	= css::build_structure_css();
		// 	$response->msg		= 'OK. Request done';


		// 	return $response;
		// }//end build_structure_css




	/**
	* CONVERT_SEARCH_OBJECT_TO_SQL_QUERY
	* @param object $rqo
	* @return object $response
	*/
	public static function convert_search_object_to_sql_query(object $rqo) : object {

		set_time_limit ( 259200 );  // 3 days
		// session_write_close();

		// response
			$response = new stdClass();
				$response->result	= false;
				$response->msg		= 'Error. Request failed ['.__FUNCTION__.']';

		// only super admin users can do it
			if( security::is_global_admin(logged_user_id()) !== true ){
				return $response;
			}

		// options
			$options	= $rqo->options ?? null;
			$sqo		= is_string($options)
				? json_handler::decode($options)
				: $options;


		// search if not empty
			if (!empty($sqo)) {

				// search exec
					$search	= search::get_instance($sqo);
					$rows	= $search->search();

				// SQL string query decorator
					$sql_query = $rows->strQuery ?? '';

					$ar_lines = explode(PHP_EOL, $sql_query);
					$ar_final = array_map(function($line){
						$line = trim($line);
						// if (strpos($line, '--')===0) {
						// 	$line = '<span class="notes">'.$line.'</span>';
						// }
						return $line;
					}, $ar_lines);
					$sql_query = implode(PHP_EOL, $ar_final);
					// $sql_query = '<pre>'.$sql_query.'</pre>';

				$response->result	= true;
				$response->msg		= $sql_query;
				$response->rows		= $rows;
			}


		return $response;
	}//end convert_search_object_to_sql_query



	/**
	* CHANGE_LANG
	* @param object $rqo
	* {
	*	action	: 'change_lang',
	*	dd_api	: 'dd_utils_api',
	*	options	: {
	*		dedalo_data_lang		: lang,
	*		dedalo_application_lang	: lang
	*	}
	*  }
	* @return object $response
	*/
	public static function change_lang(object $rqo) : object {

		// options
			$options					= $rqo->options;
			$dedalo_data_lang			= $options->dedalo_data_lang ?? null; // DEDALO_DATA_LANG;
			$dedalo_application_lang	= $options->dedalo_application_lang ?? null; // DEDALO_APPLICATION_LANG;

		// response
			$response = new stdClass();
				$response->result	= true;
				$response->msg		= 'OK. Request done ['.__METHOD__.']';

		// dedalo_data_lang_sync
			if (defined('DEDALO_DATA_LANG_SYNC') && DEDALO_DATA_LANG_SYNC===true) {
				if (!empty($dedalo_application_lang)) {
					// data_lang from application_lang
					$dedalo_data_lang = $dedalo_application_lang;
				}else if (!empty($dedalo_data_lang)) {
					// application_lang from data_lang
					$dedalo_application_lang = $dedalo_data_lang;
				}
			}

		// dedalo_data_lang
			if (!empty($dedalo_data_lang)) {
				$dedalo_data_lang = trim( safe_xss($dedalo_data_lang) );
				# Save in session
				$_SESSION['dedalo']['config']['dedalo_data_lang'] = $dedalo_data_lang;

				$response->msg .= ' Changed dedalo_data_lang to '.$dedalo_data_lang;
			}

		// dedalo_application_lang
			if (!empty($dedalo_application_lang)) {
				$dedalo_application_lang = trim( safe_xss($dedalo_application_lang) );
				# Save in session dedalo_application_lang
				$_SESSION['dedalo']['config']['dedalo_application_lang'] = $dedalo_application_lang;

				$response->msg .= ' Changed dedalo_application_lang to '.$dedalo_application_lang;
			}

		// cache update
			// precalculate profiles datalist security access in background
			// This file is generated on every user login, launching the process in background
			// or, when current lang is not cached yet (on user change data lang in menu)
			// cache_file_name. Like 'cache_tree_'.DEDALO_DATA_LANG.'.json'
			if (defined('DEDALO_CACHE_MANAGER') && isset(DEDALO_CACHE_MANAGER['files_path']) && login::is_logged()===true) {
				$cache_file_name = component_security_access::get_cache_tree_file_name(
					$dedalo_application_lang ?? DEDALO_APPLICATION_LANG
				);
				// check if cache file already exists
				$cache_file_exists = dd_cache::cache_file_exists((object)[
					'file_name' => $cache_file_name
				]);
				if ($cache_file_exists===false) {
					// cache do not exists. Create a new one
					debug_log(__METHOD__
						." Generating security access datalist in background... " . PHP_EOL
						.' cache_file_name: ' . $cache_file_name
						, logger::DEBUG
					);
					dd_cache::process_and_cache_to_file((object)[
						'process_file'	=> DEDALO_CORE_PATH . '/component_security_access/calculate_tree.php',
						'data'			=> (object)[
							'session_id'	=> session_id(),
							'user_id'		=> logged_user_id(),
							'lang'			=> $dedalo_application_lang ?? DEDALO_APPLICATION_LANG
						],
						'file_name'		=> $cache_file_name,
						'wait'			=> false
					]);
				}
			}

		// debug
			debug_log(__METHOD__." response ".to_string($response), logger::DEBUG);


		return $response;
	}//end change_lang



	/**
	* LOGIN
	* @param object $rqo
	* {
	*	action	: 'login',
	*	dd_api	: 'dd_utils_api',
	*	options	: {
	*		username	: username,
	*		auth		: auth
	*	}
	* }
	* @return object $response
	*/
	public static function login(object $rqo) : object {

		// options
			$options = $rqo->options;

		// login
			$response = (object)login::Login((object)[
				'username' => $options->username,
				'password' => $options->auth
			]);


		return $response;
	}//end login



	/**
	* QUIT
	* @param object $rqo
	* {
	*	action	: 'quit',
	*	dd_api	: 'dd_utils_api',
	*	options	: {}
	* }
	* @return object $response
	*/
	public static function quit(object $rqo) : object {

		// options
			$options = $rqo->options;

		// response
			$response = new stdClass();
				$response->result	= true;
				$response->msg		= 'OK. Request done ['.__METHOD__.']';

		// Login type . Get before unset session
			$login_type = isset($_SESSION['dedalo']['auth']['login_type'])
				? $_SESSION['dedalo']['auth']['login_type']
				: 'default';

		// Quit action
			$result = login::Quit( $options );

		// Close script session after log out
			session_write_close();

		// Response
			$response->result	= $result;
			$response->msg		= 'OK. Request done ['.__FUNCTION__.']';

			// saml logout
				if ($login_type==='saml' && defined('SAML_CONFIG') && SAML_CONFIG['active']===true && isset(SAML_CONFIG['logout_url'])) {
					$response->saml_redirect = SAML_CONFIG['logout_url'];
				}


		return $response;
	}//end quit



	/**
	* INSTALL
	* Control the install process calls to be re-direct to the correct actions
	* @param object $rqo
	* {
	*	action	: 'install',
	*	dd_api	: 'dd_utils_api',
	*	options	: {
	*		action : 'to_update'
	*	}
	* }
	* @return object $response
	*/
	public static function install(object $rqo) : object {

		// options
			$options	= $rqo->options;
			$action		= $options->action;

		// response
			$response = new stdClass();
				$response->result	= false;
				$response->msg		= 'Error. Request failed';

		// check the dedalo install status (config_auto.php)
		// When install is finished, it will be set automatically to 'installed'
		if(
			defined('DEDALO_INSTALL_STATUS')
			&& DEDALO_INSTALL_STATUS==='installed'
			&& $action!=='install_hierarchies'
		){
			$response->msg = 'Error. Request not valid, Dédalo was installed';
			return $response;
		}

		switch ($action) {
			case 'install_db_from_default_file':

				// check db is already imported for security
					$db_tables		= backup::get_tables(); // returns array empty if not is imported
					$db_is_imported	= (bool)in_array('matrix_users', $db_tables);
					if ($db_is_imported===true) {
						$response->msg  = 'Error. Current database is not empty: ' . DEDALO_DATABASE_CONN .'. ';
						$response->msg .= "Maybe your DEDALO_INSTALL_STATUS var it's not set as 'installed'";
						return $response;
					}

				// exec
					$response = (object)install::install_db_from_default_file();

				break;

			case 'to_update':

				//exec
					$response = (object)install::to_update();
				break;

			case 'install_hierarchies':

				// check login for security
					if (login::is_logged()!==true) {
						$response->msg = 'Error. You are not logged in';
						return $response;
					}

				$install_hierarchies_options = $options;

				// exec
					$response = (object)install::install_hierarchies( $install_hierarchies_options );

				break;

			case 'set_root_pw':

				//exec
					$response = (object)install::set_root_pw($options);
				break;

			case 'install_finish':

				//exec
					$response = (object)install::set_install_status('installed');
				break;

			default:
				$response->msg		= 'Error. Request not valid';
				break;
		}


		return $response;
	}//end install





	/**
	* UPLOAD
	* Manages given upload file
	* Sample expected $json_data:
	* {
		"action": "upload",
		"dd_api": "dd_utils_api",
		"options": {
			"key_dir": "av",
			"file_name": "foc-intro.mp4",
			"chunked": "true",
			"start": "2097152",
			"end": "4194304",
			"chunk_index": "1",
			"total_chunks": "19",
			"file_to_upload": {
				"name": "blob",
				"full_path": "blob",
				"type": "application/octet-stream",
				"tmp_name": "/private/var/tmp/phprfdEk5",
				"error": 0,
				"size": 2097152
			}
		}
	* }
	* @param object $rqo
	* @return object $response
	*/
	public static function upload(object $rqo) : object {
		$start_time=start_time();

		session_write_close();

		// options
			$options		= $rqo->options;
			$file_to_upload	= $options->file_to_upload ?? $options->file ?? $options->upload;	// assoc array Added from PHP input '$_FILES'
			$key_dir		= basename($options->key_dir); // string like 'tool_upload'
			$tipo			= $options->tipo ?? null;
			$chunked		= isset($options->chunked) // received as string 'true'|'false'
				? (bool)json_decode($options->chunked)
				: false;

		// response
			$response = new stdClass();
				$response->result	= false;
				$response->msg		= 'Error. '.label::get_label('error_on_upload_file');

		// key_dir check
			if (!self::is_valid_key_dir($key_dir)) {
				$response->msg .= ' Invalid key_dir';
				return $response;
			}

		// check for upload issues
		try {

			// Undefined | Multiple Files | $_FILES Corruption Attack
			// If this request falls under any of them, treat it invalid.
				if (
					!isset($file_to_upload['error']) ||
					is_array($file_to_upload['error'])
					) {
					// throw new RuntimeException('Invalid parameters. (1)');
					$msg = ' upload: Invalid parameters. (1)';
					debug_log(__METHOD__
						." $msg " .PHP_EOL
						. to_string($rqo)
						, logger::ERROR
					);
					$response->msg .= $msg;
					return $response;
				}

			// Check $file_to_upload['error'] value.
				switch ($file_to_upload['error']) {
					case UPLOAD_ERR_OK:
						break;

					case UPLOAD_ERR_NO_FILE:
						$msg = ' upload: No file sent.';
						debug_log(__METHOD__
							. " $msg " .PHP_EOL
							. ' file_to_upload error: ' .to_string($file_to_upload['error']) . PHP_EOL
							.' rqo: ' . to_string($rqo)
							, logger::ERROR
						);
						$response->msg .= $msg;
						return $response;

					case UPLOAD_ERR_INI_SIZE:
					case UPLOAD_ERR_FORM_SIZE:
						$msg = ' upload: Exceeded filesize limit.';
						debug_log(__METHOD__
							. " $msg " .PHP_EOL
							. ' file_to_upload error: ' .to_string($file_to_upload['error']) . PHP_EOL
							.' rqo: ' . to_string($rqo)
							, logger::ERROR
						);
						$response->msg .= $msg;
						return $response;

					case UPLOAD_ERR_PARTIAL:
						$msg = ' upload: The uploaded file was only partially uploaded.';
						debug_log(__METHOD__
							. " $msg " .PHP_EOL
							. ' file_to_upload error: ' .to_string($file_to_upload['error']) . PHP_EOL
							.' rqo: ' . to_string($rqo)
							, logger::ERROR
						);
						$response->msg .= $msg;
						return $response;

					case UPLOAD_ERR_CANT_WRITE:
						$msg = ' upload: Failed to write file to disk.';
						debug_log(__METHOD__
							. " $msg " .PHP_EOL
							. ' file_to_upload error: ' .to_string($file_to_upload['error']) . PHP_EOL
							.' rqo: ' . to_string($rqo)
							, logger::ERROR
						);
						$response->msg .= $msg;
						return $response;

					case UPLOAD_ERR_NO_TMP_DIR:
						$msg = ' upload: Missing a temporary folder.';
						debug_log(__METHOD__
							. " $msg " .PHP_EOL
							. ' file_to_upload error: ' .to_string($file_to_upload['error']) . PHP_EOL
							.' rqo: ' . to_string($rqo)
							, logger::ERROR
						);
						$response->msg .= $msg;
						return $response;

					default:
						$msg = ' upload: Unknown errors.';
						debug_log(__METHOD__
							." $msg " .PHP_EOL
							. ' file_to_upload error: ' .to_string($file_to_upload['error']) . PHP_EOL
							.' rqo: ' . to_string($rqo)
							, logger::ERROR
						);
						$response->msg .= $msg;
						return $response;
				}

			// You should also check filesize here.
				// if ($file_to_upload['size'] > 1000000) {
				// 	throw new RuntimeException('Exceeded filesize limit.');
				// }

				// filename
				$file_name		= $file_to_upload['name'];
				$file_tmp_name	= $file_to_upload['tmp_name'];
				$file_type 		= $file_to_upload['type']; // mime like 'image/tiff'

				// blob case (componen_3d posterframe auto-generated)
				if ($file_name==='blob' && isset($options->file_name)) {
					$file_name = basename($options->file_name);
				}

				// extension
				$extension	= strtolower( pathinfo($file_name, PATHINFO_EXTENSION) );

				// Do not trust $file_to_upload['mime'] VALUE !!
				// Check MIME Type by yourself.

				$finfo		= new finfo(FILEINFO_MIME_TYPE);
				$file_mime	= $finfo->file($file_tmp_name); // ex. string 'text/plain'

			// name
				$name = $file_name;
				if($chunked===true) {
					$file_name		= basename($options->file_name);
					$total_chunks	= $options->total_chunks;
					$chunk_index	= (int)$options->chunk_index;
					$tmp_name		= basename($file_tmp_name);
					$extension		= 'blob';
					$name			= "{$chunk_index}-{$tmp_name}.{$extension}";
					$file_mime		= 'application/octet-stream';
				}

			// CHECKING
				$known_mime_types = self::get_known_mime_types();
				// Check MIME type
					$mime_is_known = false;
					foreach ($known_mime_types as $current_mime) {
						if ($current_mime['mime']===$file_mime) {
							$mime_is_known = true;
							break;
						}
					}
					if ($mime_is_known===false) {
						// throw new RuntimeException('Invalid file format.');
						debug_log(__METHOD__
							." Error. Stopped upload unknown file mime type." . PHP_EOL
							. ' file_mime: ' . to_string($file_mime) . PHP_EOL
							. ' file_tmp_name: ' . to_string($file_tmp_name) . PHP_EOL
							. ' extension: ' . to_string($extension) . PHP_EOL
							. ' known_mime_types: ' . to_string($known_mime_types)
							, logger::ERROR
						);
						$msg = ' upload: Invalid file format. (mime: '.$file_mime.')';
						$response->msg .= $msg;
						return $response;
					}
				// check extension
					$extension_is_allowed = false;
					foreach ($known_mime_types as $current_mime) {
						if (in_array($extension, $current_mime['extension'])) {
							$extension_is_allowed = true;
							break;
						}
					}
					if ($extension_is_allowed===false) {
						$response->msg .= "Error. Invalid file extension [2] ".$extension;
						debug_log(__METHOD__
							. ' '.$response->msg .PHP_EOL
							. ' extension from file_name: '. to_string($extension) .PHP_EOL
							. ' file_name: '. to_string($file_name) .PHP_EOL
							. ' file_to_upload: '. to_string($file_to_upload)
							, logger::ERROR
						);
						return $response;
					}

				// check for upload server errors
					$uploaded_file_error		= $file_to_upload['error'];
					$uploaded_file_error_text	= self::error_number_to_text($uploaded_file_error);
					if ($uploaded_file_error!==0) {
						$response->msg .= ' - '.$uploaded_file_error_text;
						return $response;
					}

				// check file is available in temp dir
					if(!file_exists($file_tmp_name)) {
						debug_log(__METHOD__
							. " Error on locate temporary file ". PHP_EOL
							. ' file_tmp_name' .to_string($file_tmp_name)
							, logger::ERROR
						);
						$response->msg .= "Uploaded file not found in temporary folder";
						return $response;
					}

			// Manage uploaded file
				// check tmp upload dir
					if (!defined('DEDALO_UPLOAD_TMP_DIR')) {
						debug_log(__METHOD__
							." DEDALO_UPLOAD_TMP_DIR is not defined. Please, define constant 'DEDALO_UPLOAD_TMP_DIR' in config file." .PHP_EOL
							." (Using fallback value instead: DEDALO_MEDIA_PATH . '/import/file')" .PHP_EOL
							." Config constant 'DEDALO_UPLOAD_TMP_DIR' is mandatory!"
							, logger::ERROR
						);
						$response->msg .= " Config constant 'DEDALO_UPLOAD_TMP_DIR' is mandatory!";
						return $response;
					}
				// user_id. Currently logged user
					$user_id = logged_user_id();
					$tmp_dir = DEDALO_UPLOAD_TMP_DIR . '/'. $user_id . '/' . $key_dir;

				// tmp_dir. Check the target_dir, if it is not created it will be created for use.
					if(!create_directory($tmp_dir, 0750)) {
						$response->msg .= ' Error on read or create tmp_dir directory. Permission denied';
						return $response;
					}

				// move file to target path
					$target_path	= $tmp_dir . '/' . $name;
					$moved			= move_uploaded_file($file_tmp_name, $target_path);
					// verify move file is successful
					if ($moved!==true) {
						debug_log(__METHOD__.PHP_EOL
							.'Error on get/move temp file to target_path '.PHP_EOL
							.'source: '.$file_tmp_name.PHP_EOL
							.'target: '.$target_path
							, logger::ERROR
						);
						$response->msg .= 'Uploaded file Error on get/move to target_path.';
						return $response;
					}else{
						debug_log(__METHOD__
							. " Moved file >>>>>>>>>>>>>> " . PHP_EOL
							. ' from file_tmp_name: '.$file_tmp_name . PHP_EOL
							. ' to target_path: '.$target_path
							, logger::WARNING
						);
					}

				// thumbnail file
					if(!$chunked===true) {
						$thumb_options = new stdClass();
							$thumb_options->tmp_dir		= $tmp_dir;
							$thumb_options->name		= $name;
							$thumb_options->target_path	= $target_path;
							$thumb_options->key_dir		= $key_dir;
							$thumb_options->user_id		= $user_id;

						$thumbnail_url = dd_utils_api::create_thumbnail($thumb_options);
					}

			// file_data to client. POST file (sent across $_FILES) info and some additions
				// Example of received data:
				// "file_to_upload": {
				//		"name": "exported_templates-web_-1-dd477.csv",
				//		"full_path": "exported_templates-web_-1-dd477.csv",
				//		"type": "text/csv",
				//		"tmp_name": "/private/var/tmp/phpQ02UUO",
				//		"error": 0,
				//		"size": 29892
				// }
				$file_data = new stdClass();
					$file_data->name			= $file_name; // like 'My Picture 1.jpg'
					$file_data->type			= $file_to_upload['type']; // like 'image\/jpeg'
					$file_data->tmp_dir			= 'DEDALO_UPLOAD_TMP_DIR'; // like DEDALO_MEDIA_PATH . '/upload/service_upload/tmp'
					$file_data->key_dir			= $key_dir; // like 'tool_upload'
					$file_data->tmp_name		= $name; // like 'phpv75h2K'
					$file_data->error			= $file_to_upload['error']; // like 0
					$file_data->size			= $file_to_upload['size']; // like 878860 (bytes)
					$file_data->time_sec		= exec_time_unit($start_time,'sec');
					$file_data->extension		= $extension;
					$file_data->thumbnail_url	= $thumbnail_url ?? null;
					$file_data->chunked			= $chunked;
					if($chunked===true) {
						$file_data->total_chunks	= $total_chunks;
						$file_data->chunk_index		= $chunk_index;
					}

			// key_dir cases response
				switch ($key_dir) {

					case 'web': // uploading images from text editor
						$safe_file_name	= sanitize_file_name($file_name); // clean file name
						$file_path		= DEDALO_MEDIA_PATH . '/image' . DEDALO_IMAGE_WEB_FOLDER . '/' . $safe_file_name;
						$file_url		= DEDALO_MEDIA_URL  . '/image' . DEDALO_IMAGE_WEB_FOLDER . '/' . $safe_file_name;
						$current_path	= $target_path;
						$response		= rename($current_path, $file_path)
							? (object)['url' => $file_url]
							: (object)['error' => 'Error moving file'];
						// debug
							debug_log(__METHOD__." --> saved file as : ".$file_path, logger::DEBUG);
						break;

					default:
						// all is OK response
						$response->result		= true;
						$response->file_data	= $file_data;
						$response->msg			= 'OK. '.label::get_label('file_uploaded_successfully');
						break;
				}

			// logger activity
			// (!) Don't use here because on chunk file, is not possible to know if current chunk is the last one (random upload order)
			// (!) Moved this activity log to class tool_upload::process_uploaded_file method
				// $finished = ($chunked===true)
				// 	? ($chunk_index === ($total_chunks - 1)) // is last chunk
				// 	: true;
				// if ($finished===true && !empty($tipo)) {
				// 	logger::$obj['activity']->log_message(
				// 		'UPLOAD COMPLETE',
				// 		logger::INFO,
				// 		$tipo,
				// 		NULL,
				// 		[
				// 			'msg'				=> 'Upload file complete',
				// 			'file_data'			=> json_encode($file_data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT),
				// 			'file_name' 		=> $file_data->name,
				// 			'file_size' 		=> format_size_units($file_data->size),
				// 			'time_sec' 			=> $file_data->time_sec,
				// 			'f_error'			=> $file_data->error ?? null
				// 		]
				// 	);
				// }

		}catch (RuntimeException $e) {

			$response->msg .= ' Request failed: '. $e->getMessage();
			debug_log(__METHOD__
				. ' RuntimeException catch. msg: '.$response->msg
				, logger::ERROR
			);
		}


		return $response;
	}//end upload



	/**
	* GET_SYSTEM_INFO
	* @param object $rqo
	*
	*	dd_api	: 'dd_utils_api',
	*	action	: 'join_chunked_files_uploaded',
	*	options	: {
	*		file_data		: file_data,
	*		files_chunked	: files_chunked
	*	}
	* }
	* @return object response
	*/
	public static function join_chunked_files_uploaded(object $rqo) : object {

		// unlock session and keep joining even if the proxy drops the connection
			session_write_close();
			ignore_user_abort(true);

		// options
			$options		= $rqo->options;
			$files_chunked	= $options->files_chunked;
			$file_data		= $options->file_data;
			$key_dir 		= basename($file_data->key_dir);

		// response
			$response = new stdClass();
				$response->result 	= false;
				$response->msg 		= 'Error. Request failed';

		// key_dir check
			if (!self::is_valid_key_dir($key_dir)) {
				$response->msg .= ' Invalid key_dir';
				return $response;
			}

		// file_path
			$user_id	= logged_user_id();
			$file_path	= DEDALO_UPLOAD_TMP_DIR . '/'. $user_id . '/' . $key_dir;

		// tmp_joined_file
			$tmp_joined_file = 'tmp_'.basename($file_data->name);

		// target path of the final file joined
			$target_path = $file_path .'/'. $tmp_joined_file;

		// join into part_<name> and rename at the end, so tmp_<name> only exists once fully joined (the client polls for it)
			$part_path = $file_path .'/part_'. basename($file_data->name);

		// extension
			$extension = strtolower( pathinfo($tmp_joined_file, PATHINFO_EXTENSION) );

		// check extension
			$known_mime_types		= self::get_known_mime_types();
			$extension_is_allowed	= false;
			foreach ($known_mime_types as $current_mime) {
				if (in_array($extension, $current_mime['extension'])) {
					$extension_is_allowed = true;
					break;
				}
			}
			if ($extension_is_allowed===false) {
				$response->msg .= "Error. Invalid file extension [2] ".$extension;
				debug_log(__METHOD__
					. ' '.$response->msg .PHP_EOL
					. ' extension: '. to_string($extension) .PHP_EOL
					, logger::ERROR
				);
				return $response;
			}

		// joining large files (several GB) can exceed max_execution_time
			set_time_limit(0);

		// remove stale files from a previous failed attempt (chunks are appended)
			foreach ([$target_path, $part_path] as $stale_path) {
				if (file_exists($stale_path)) {
					unlink($stale_path);
				}
			}

		// open target once and stream every chunk into it (constant memory)
			$target_handle = fopen($part_path, 'ab');
			if ($target_handle===false) {
				$response->msg = "Unable to open target file: {$tmp_joined_file}";
				debug_log(__METHOD__
					.' Error: '.$response->msg
					, logger::ERROR
				);
				return $response;
			}

		// loop through temp files and append the content
			$error_msg = null;
			foreach ($files_chunked as $chunk_filename) {

				// copy chunk
				$chunk_filename	= basename($chunk_filename);
				$temp_file_path	= "{$file_path}/{$chunk_filename}";
				if (!is_file($temp_file_path)) {
					$error_msg = "Chunk file not found: {$chunk_filename}";
					break;
				}
				$chunk_size = filesize($temp_file_path);
				if ( empty($chunk_size) ){
					$error_msg = "Chunk file is empty: {$chunk_filename}";
					break;
				}
				$chunk_handle = fopen($temp_file_path, 'rb');
				if ($chunk_handle===false) {
					$error_msg = "Unable to open chunk file: {$chunk_filename}";
					break;
				}

				// add chunk to main file
				$copied = stream_copy_to_stream($chunk_handle, $target_handle);
				fclose($chunk_handle);
				if ($copied!==$chunk_size) {
					$error_msg = "Incomplete copy of chunk: {$chunk_filename} (".to_string($copied)." of {$chunk_size} bytes)";
					break;
				}

				// delete chunk
				unlink($temp_file_path);
				if ( file_exists($temp_file_path) ) {
					$error_msg = "Your temp files could not be deleted.";
					break;
				}
			}
			fclose($target_handle);

		// on error, remove the partial file and the remaining chunks: the join cannot be resumed and they would fill the disk
			if ($error_msg!==null) {
				foreach ($files_chunked as $chunk_filename) {
					$temp_file_path = $file_path .'/'. basename($chunk_filename);
					if (is_file($temp_file_path)) {
						unlink($temp_file_path);
					}
				}
				unlink($part_path);
				$response->msg = $error_msg;
				debug_log(__METHOD__
					.' Error: '.$response->msg
					, logger::ERROR
				);
				return $response;
			}

		// thumbnail
			$thumb_options = new stdClass();
				$thumb_options->tmp_dir		= $file_path;
				$thumb_options->name		= $tmp_joined_file;
				$thumb_options->target_path	= $part_path;
				$thumb_options->key_dir		= $key_dir;
				$thumb_options->user_id		= $user_id;
			$thumbnail_url = dd_utils_api::create_thumbnail($thumb_options);

		// publish the joined file
			if (!rename($part_path, $target_path)) {
				$response->msg = "Unable to rename joined file: {$tmp_joined_file}";
				debug_log(__METHOD__
					.' Error: '.$response->msg
					, logger::ERROR
				);
				return $response;
			}

		// set the file values
			$file_data->tmp_name		= $tmp_joined_file; // like 'phpv75h2K'
			$file_data->extension		= $extension;
			$file_data->thumbnail_url	= $thumbnail_url ?? null;

		// response. All is OK response
			$response->result		= true;
			$response->file_data	= $file_data;
			$response->msg			= 'OK. '.label::get_label('file_uploaded_successfully');


		return $response;
	}//end get_system_info



	/**
	* LIST_UPLOADED_FILES
	* Used by the upload lib (Dropzone) to get the list of already uploaded files on server
	* @param object $rqo
	* 	Object with only the key_dir name like { key_dir: 'oh1_4' }
	* @return object $response
	* 	response->result:
	* 	Array of objects like: [{
	* 		url : server generated thumbnail url,
	* 		name : file name like 'my_photo51.jpg',
	* 		size : informative file size in bytes like 6528743 (from original file, not from the thumb)
	* 	}]
	*/
	public static function list_uploaded_files(object $rqo) : object {

		// unlock session
			session_write_close();
			ignore_user_abort(true);

		$response = new stdClass();
			$response->result 	= false;
			$response->msg 		= 'Error. Request failed';

		// options
			$key_dir = basename($rqo->options->key_dir ?? '');

		// key_dir check
			if (!self::is_valid_key_dir($key_dir)) {
				$response->msg .= ' Invalid key_dir';
				return $response;
			}

		// dir
			$user_id = logged_user_id();
			$tmp_dir = DEDALO_UPLOAD_TMP_DIR . '/'. $user_id . '/' . $key_dir;
			$tmp_url = DEDALO_UPLOAD_TMP_URL . '/'. $user_id . '/' . $key_dir;

		// read files dir
			$files = [];
			if (is_dir($tmp_dir)) {
				$files_raw	= scandir($tmp_dir);
				foreach ($files_raw as $file_name) {
					$file_path = $tmp_dir . '/' . $file_name;

					if (strlen($file_name) > 0 && $file_name[0]!=='.' && is_file($file_path)) {

						$info		= pathinfo($file_name);
						$basemane	= basename($file_name,'.'.$info['extension']);

						$files[] = (object)[
							'url'	=> $tmp_url .'/thumbnail/'. $basemane . '.jpg',
							'name'	=> $file_name,
							'size'	=> filesize($file_path)
						];
					}
				}
			}

		// response
			$response->result	= $files;
			$response->msg		= 'OK. Request done';

		return $response;
	}//end list_uploaded_files



	/**
	* DELETE_UPLOADED_FILE
	* Used by the upload lib (Dropzone) to delete already uploaded files on server
	* @param object $rqo
	* 	Object like { file_name: 'my_photo_452.jpg', key_dir: 'rsc29_rsc176' }
	* @return object $response
	* 	response->result
	* 	Returns false if file do not exists or the unlink call do not return true
	*/
	public static function delete_uploaded_file(object $rqo) : object {

		// unlock session
			session_write_close();
			ignore_user_abort(true);

		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Error. Request failed';

		// options
			$options = $rqo->options;

		// short vars
			$file_names	= is_array($options->file_name) ? $options->file_name : [$options->file_name];
			$key_dir	= basename($options->key_dir); // key_dir. Contraction of tipo + section_tipo, like: 'rsc29_rsc176'

		// key_dir check
			if (!self::is_valid_key_dir($key_dir)) {
				$response->msg .= ' Invalid key_dir';
				return $response;
			}

		// dir
			$user_id	= logged_user_id();
			$tmp_dir	= DEDALO_UPLOAD_TMP_DIR . '/'. $user_id . '/' . $key_dir;

		// delete each file
			foreach ($file_names as $file_name) {

				// file_path
					$file_name = basename($file_name);
					$file_path = $tmp_dir . '/' . $file_name;

				// delete file
					if (file_exists($file_path) && !unlink($file_path)) {
						$response->result	= false;
						$response->msg		= "Error on delete file (unable to unlink file): ".to_string($file_path);
						debug_log(__METHOD__
							." $response->msg"
							, logger::ERROR
						);
					}

				// thumb_path
					$info				= pathinfo($file_name);
					$basemane			= basename($file_name,'.'.$info['extension']);
					$thumb_file_path	= $tmp_dir . '/thumbnail/' . $basemane . '.jpg';

				// delete thumb
					if (file_exists($thumb_file_path) && !unlink($thumb_file_path)) {
						$response->result	= false;
						$response->msg		= "Error on delete thumb file (unable to unlink file): ".to_string($thumb_file_path);
						debug_log(__METHOD__
							." $response->msg"
							, logger::ERROR
						);
					}
			}//end foreach ($file_names as $file_name)

		// response
			$response->result	= true;
			$response->msg		= 'OK. Request done';


		return $response;
	}//end delete_uploaded_file



	/**
	* UPDATE_LOCK_COMPONENTS_STATE
	* Connects to database and updates user lock components state
	* on focus or blur user actions
	* @param object $rqo
	* 	Sample:
	* 	{
	*	    "dd_api": "dd_utils_api",
	*	    "action": "update_lock_components_state",
	*	    "options": {
	*	        "component_tipo": "hierarchy24",
	*	        "section_tipo": "sv1",
	*	        "section_id": "1",
	*	        "action": "focus"
	*	    }
	*	}
	* @return object $response
	* 	Sample:
	* 	{
	*	    "result": true,
	*	    "msg": "Updated db lock elements",
	*	    "dato": [
	*	        {
	*	            "date": "2024-03-08 09:30:10",
	*	            "action": "focus",
	*	            "user_id": null,
	*	            "section_id": "1",
	*	            "section_tipo": "test3",
	*	            "full_username": "Unknown",
	*	            "component_tipo": "test94"
	*	        }
	*	    ],
	*	    "in_use": false
	*	}
	*/
	public static function update_lock_components_state(object $rqo) : object {

		// session unlock
		session_write_close();

		// Ignore user abort action
		ignore_user_abort(true);

		// options
			$options		= $rqo->options;
			$section_id		= $options->section_id;
			$section_tipo	= $options->section_tipo;
			$component_tipo	= $options->component_tipo ?? null;
			$action			= $options->action; // delete_user_section_locks | blur | focus
			$user_id		= logged_user_id();
			$full_username	= ($user_id<0)
				? 'Debug user'
				: (logged_user_full_username() ?? 'Unknown');

		// event_element
			$event_element = new stdClass();
				$event_element->section_id		= $section_id;
				$event_element->section_tipo	= $section_tipo;
				$event_element->component_tipo	= $component_tipo;
				$event_element->action			= $action;
				$event_element->user_id			= $user_id;
				$event_element->full_username	= $full_username;
				$event_element->date			= date("Y-m-d H:i:s");

		// response
			$response = lock_components::update_lock_components_state( $event_element );

		// dedalo_notification (from config)
			$response->dedalo_notification = (defined('DEDALO_NOTIFICATION'))
				? DEDALO_NOTIFICATION
				: null;
			// DEDALO_NOTIFICATION_CUSTOM from area_maintenance (overwrites the default notification)
				if (defined('DEDALO_NOTIFICATION_CUSTOM') && !empty(DEDALO_NOTIFICATION_CUSTOM)) {
					$response->dedalo_notification = DEDALO_NOTIFICATION_CUSTOM;
				}


		return $response;
	}//end update_lock_components_state



	/**
	* GET_DEDALO_FILES
	* Connects to database and updates user lock components state
	* on focus or blur user actions
	* @param object $rqo
	* @return object $response
	*/
	public static function get_dedalo_files(object $rqo) : object {

		// session unlock
		session_write_close();

		// response
			$response = new stdClass();
				$response->result	= false;
				$response->msg		= 'Error. Request failed ['.__FUNCTION__.']';

		// get files
			$files = [];

			// CORE
				// css add 'main.css' to preserve coherence
				$files[] = (object)[
					'type'	=> 'css',
					'url'	=>  DEDALO_CORE_URL . '/page/css/main.css'
				];
				// js
				$core_js_files	= get_dir_files(DEDALO_CORE_PATH, ['js'], function($el) {
					// remove self base directory from file path
					$file = str_replace(DEDALO_CORE_PATH, '', $el);
					if ( stripos($file, '/acc/')!==false ||
						 strpos($file, '/themes/')!==false || // ignore themes directory
						 strpos($file, '/ontology/')!==false || // ignore old ontology files (no modules)
						 stripos($file, '/old/')!==false ||
						 stripos($file, '/lib/')!==false || // ignore libraries
						 strpos($file, '/test/')!==false || // ignore test
						 strpos($file, '/plug-ins/')!==false || // ignore test
						 strpos($file, '/fonts/')!==false || // ignore fonts
						 strpos($file, 'worker_cache.js')!==false ||
						 strpos($file, '/sw.js')!==false // ignore service worker
						) {
						return null; // item does not will be added to the result
					}
					// only js dirs
					if (strpos($file, '/js/')===false) {
						return null; // item does not will be added to the result
					}

					return DEDALO_CORE_URL . '' . $file;
				});
				foreach ($core_js_files as $url) {
					$files[] = (object)[
						'type'	=> 'js',
						'url'	=>  $url
					];
				}

			// TOOLS
				$tools_js_files	= get_dir_files(DEDALO_TOOLS_PATH, ['js','css'], function(string $el) : ?string {
					// remove self base directory from file path
					$file = str_replace(DEDALO_TOOLS_PATH, '', $el);

					if ( stripos($file, '/acc/')!==false ||
						 stripos($file, '/old/')!==false ||
						 stripos($file, '/lib/')!==false
						) {
						return null; // item does not will be added to the result
					}

					// tool first level dir
					// Sample:
					// [
					// 	"",
					// 	"tool_user_admin",
					// 	"js",
					// 	"render_tool_user_admin.js"
					// ]
					$ar_levels = explode('/', $file);
					if ($ar_levels[2]!=='js' && $ar_levels[2]!=='css') {
						return null; // item does not will be added to the result
					}

					return DEDALO_TOOLS_URL . '' . $file;
				});
				foreach ($tools_js_files as $file_url) {
					$files[] = (object)[
						'type'	=> 'js',
						'url'	=>  $file_url
					];
				}

		// response
			// result: list of all Dédalo main files (JS/CSS) without the libraries
			$response->result = $files;
			// dedalo_version: used to set the cache version in worker
			$response->dedalo_version = DEDALO_VERSION;
			// msg: Success message for browser
			$response->msg = 'OK. Request done successfully';


		return $response;
	}//end get_dedalo_files



	/**
	* GET_PROCESS_STATUS
	* Used for SSE events to get info about know background process
	* Note that PID (process id) and PFILE (process file name) are mandatory
	* @param object $rqo
	* @return die()
	*/
	public static function get_process_status(object $rqo) {
		$start_time=start_time();

		// max_execution_time
			ini_set('max_execution_time', 36000); // seconds ( 3600 * 10 ) = 10 hours

		// session unlock
			session_write_close();

		// options
			$pfile	= $rqo->options->pfile;
			$pid	= $rqo->options->pid;

		// only logged users can access SSE events
			// SSE formatted message (is_running false) to stop client reconnections
			if(login::is_logged()!==true) {
				$msg = 'Authentication error: please login';
				$output = (object)[
					'pid'			=> $pid,
					'pfile'			=> $pfile,
					'is_running'	=> false,
					'data'			=> (object)[
						'msg' => $msg
					],
					'time'			=> date("Y-m-d H:i:s"),
					'errors'		=> [$msg]
				];
				echo 'data:' . "\n" . json_handler::encode($output, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n";
				die();
			}

		// header print as event stream
			header("Content-Type: text/event-stream");
			header("Cache-Control: no-cache, must-revalidate");
			header('Connection: keep-alive');
			header("Access-Control-Allow-Origin: *");
			header('X-Accel-Buffering: no'); // nginx buffer control

		// mandatory vars
			if (empty($pfile) || empty($pid)) {
				$output = (object)[
					'pid'			=> $pid,
					'pfile'			=> $pfile,
					'is_running'	=> false,
					'data'			=> (object)[
						'msg' => 'Error: pfile and pid are mandatory'
					],
					'time'			=> date("Y-m-d H:i:s"),
					'errors'		=> ['Error: pfile and pid are mandatory']
				];
				echo json_handler::encode($output, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL . PHP_EOL;
				die();
			}

		// process
			$process = new process();
				$process->setPid($pid);
				$process->setFile(process::get_process_path() .'/'. $pfile);

		// event loop
			// update rate (int milliseconds)
			$update_rate = $rqo->update_rate ?? 1000;
			while (1) {

				// process info updated on each loop
					$is_running	= $process->status(); // bool is running
					$array_data	= $process->read(); // array data
					// encode
					$value = isset($array_data[0])
						? (json_decode($array_data[0]) ?? $array_data[0])
						: '';

					$data = (!is_object($value))
						? (object)[
							'msg' => $value
						  ]
						: $value;

				// output JSON to client
					$output = (object)[
						'pid'			=> $pid,
						'pfile'			=> $pfile,
						'is_running'	=> $is_running,
						'data'			=> $data,
						'time'			=> date("Y-m-d H:i:s"),
						'total_time' 	=> exec_time_unit_auto($start_time),
						'update_rate'	=> $update_rate,
						'errors'		=> []
					];

				// debug
					if(SHOW_DEBUG===true) {
						error_log('process loop: is_running: '.to_string($is_running) . ' - pid: ' .$pid. ' - pfile: ' .$pfile);
					}

				// output the response JSON string
					$a = json_handler::encode($output, JSON_UNESCAPED_UNICODE);
					if (!is_string($a)) {
						debug_log(__METHOD__
							. " Error. output value is no correctly JSON encoded ! " . PHP_EOL
							. to_string($a)
							, logger::ERROR
						);
						// force type string
						$a = to_string($a);
					}

					// fix Apache issue where small chunks are not sent correctly over HTTP 1.1
					// sometimes Apache server join some outputs into a message (merge).
					// this code helps but is not the full solution.
					// And is possible to change the Apache vhosts as:
					// 		ProxyPass fcgi://127.0.0.1:9000/dedalo/ enablereuse=on flushpackets=on max=10
					// to prevent this behavior, but the problem doesn't disappear completely.
					// With h2 protocol and SSL the problem disappear, but is necessary to be compatibles with http 1.1
					// if(DEDALO_PROTOCOL === 'http://'){
					if ($_SERVER['SERVER_PROTOCOL']==='HTTP/1.1') {
						$len = strlen($a);
						if ($len < 4096) {
							// re-create the output object and the final string
							$fill_length = 4096 - $len;
							$output->fill_buffer = $fill_length . str_pad(' ', $fill_length);
							$a = json_handler::encode($output, JSON_UNESCAPED_UNICODE);
						}
					}
					// format the message to be analyzed in client side.
					// client side doesn't use the eventManager(), the event is sent by fetch(),
					// so the format is not relevant instead in the HTTP 1.1 cases, than Apache can join or split the message in chunks
					echo 'data:';
					echo "\n";
					echo $a;
					echo "\n\n";

				// debug log. Message printed in PHP error log
					debug_log(__METHOD__
						. ' ' . $a . PHP_EOL
						, logger::DEBUG
					);

				// flush the output buffer and send echoed messages to the browser
					while (ob_get_level() > 0) {
						ob_end_flush();
					}
					flush();

				// stop on finish
					if ($is_running===false) {
						// delete database info about current process
						processes::delete_process_item(
							$pid,
							logged_user_id()
						);
						break;
					}

				// break the loop if the client aborted the connection (closed the page)
					if ( connection_aborted() ) break;

				// sleep n milliseconds before running the loop again
					$ms = $update_rate; usleep( $ms * 1000 );
			}//end while

		die();
	}//end get_process_status



	/**
	* STOP_PROCESS
	* @param object $rqo
	* @return object $response
	*/
	public static function stop_process(object $rqo) : object {

		// session unlock
			session_write_close();

		// options
			$pid		= $rqo->options->pid;
			$user_id	= $rqo->options->user_id ?? logged_user_id();

		$response = processes::stop($pid, $user_id);


		return $response;
	}//end stop_process



	// Open methods ///////////////////////////////////



	/**
	* GET_SERVER_READY_STATUS
	* Check if the server is a ontology server or not.
	* Ontology servers can provide specific ontology files as master
	* Non ontology server will refuse to use his ontology files by other installations
	* @param object $rqo
	* @return object $response
	*/
	public static function get_server_ready_status( object $rqo ) : object {

		// session unlock
			session_write_close();

		// response
		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Error. This is not an accessible Server';
			$response->errors	= [];

		//options
			$check = $rqo->options->check ?? null;


			switch ($check) {
				case 'ontology_server':
					// check constants
					// Ontology servers has a constant that able to use the server as ontology master.
						if ( defined('IS_AN_ONTOLOGY_SERVER') &&  IS_AN_ONTOLOGY_SERVER === true ) {
							$response->result	= true;
							$response->msg		= 'OK. Ontology server is ready';
							return $response;
						}
					break;

				case 'code_server':
					// check constants
					// Ontology servers has a constant that able to use the server as ontology master.
						if ( defined('IS_A_CODE_SERVER') &&  IS_A_CODE_SERVER === true ) {
							$response->result	= true;
							$response->msg		= 'OK. Code server is ready';
							return $response;
						}
					break;


			}

		return $response;
	}//end get_server_ready_status



	/**
	* GET_ONTOLOGY_UPDATE_INFO
	* Ontology server provide information about the ontology that it can provide.
	* Client needs to provide his version and the code for this server.
	* @param object $rqo
	* {
	* 	options: {
	* 		version: string
	* 		code: string
	* 	}
	* }
	* @return object $response
	*/
	public static function get_ontology_update_info( object $rqo ) : object {

		// session unlock
			session_write_close();

		// response
		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Error. Request failed';
			$response->errors	= [];

		// check if the server is ontology server, if not stop the process
		// Only ontology servers can provide his ontology files.
			if ( !defined('IS_AN_ONTOLOGY_SERVER') ||  IS_AN_ONTOLOGY_SERVER === false ) {
				$response->result	= false;
				$response->msg		= 'Error. Server is not an ontology server';
				return $response;
			}

		// RQO options
		// client will send his version and the code that able to get the ontology information
			$options = $rqo->options;

		// check configuration of the ontology constants
			if ( !defined('ONTOLOGY_DATA_IO_URL') ) {
				$response->msg		= 'Error. Dédalo is miss configured. Define ONTOLOGY_DATA_IO_URL as sample.config.php defines';
				$response->errors[]	= 'Error. Bad ONTOLOGY_DATA_IO_URL';
				return $response;
			}

		// Version
		// client needs to provide his own version of Dédalo
		// only compatible ontology files with the caller version will be provided
		// if the client doesn't send a valid version will be refuse the call.
			$string_version	= $options->version;
			$ar_version 	= explode( '.', $string_version );

			foreach($ar_version as $key => $version_number){
				if($key > 1){
					break;
				}
				$check = is_numeric( $version_number );
				if (!$check) {
					$response->msg		= 'Error. Invalid version number';
					$response->errors[]	= 'Invalid version number';
					return $response;
				}
			}

		// code
		// client needs to provide a valid code.
		// valid code is defined in config.php constant of ONTOLOGY_SERVERS
			$code = $options->code;

			// validate code comparing with config definitions
			if (defined('ONTOLOGY_SERVER_CODE')) {

				// first try from ONTOLOGY_SERVER_CODE

				$valid_code = ONTOLOGY_SERVER_CODE;

			}else{

				// second try from defined ONTOLOGY_SERVERS

				$ontology_servers = defined('ONTOLOGY_SERVERS') && !empty(ONTOLOGY_SERVERS)
					? ONTOLOGY_SERVERS
					: [];

				$valid_code = false;
				foreach ( $ontology_servers as $current_server_info ) {
					if( $current_server_info['code'] === $code ){
						$valid_code = true;
						break;
					}
				}
			}

			if( $valid_code === false ){
				$response->msg		= 'Error. Invalid code';
				$response->errors[]	= 'Invalid code';
				return $response;
			}

		// Client made a valid request.
		// get the information to be provided to client
			$response = ontology_data_io::get_ontology_update_info( $ar_version );


		return $response;
	}//end get_ontology_update_info




	/**
	* GET_CODE_UPDATE_INFO
	* Ontology server provide information about the ontology that it can provide.
	* Client needs to provide his version and the code for this server.
	* @param object $rqo
	* @return object $response
	*/
	public static function get_code_update_info( object $rqo ) : object {

		// session unlock
			session_write_close();

		// response
		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Error. Request failed';
			$response->errors	= [];

		// check if the server is ontology server, if not stop the process
		// Only ontology servers can provide his ontology files.
			if ( !defined('IS_A_CODE_SERVER') ||  IS_A_CODE_SERVER === false ) {
				$response->result	= false;
				$response->msg		= 'Error. Server is not an code server';
				return $response;
			}

		// include the widget class
			$widget_class_file = DEDALO_CORE_PATH . '/area_maintenance/widgets/update_code/class.update_code.php';
			if( !include $widget_class_file ) {
				$response->errors[] = 'Widget class file is unavailable';
				return $response;
			}

		// RQO options
		// client will send his version and the code that able to get the ontology information
			$options = $rqo->options;

		// check configuration of the ontology constants
			if ( !defined('DEDALO_CODE_FILES_DIR') ) {
				$response->msg		= 'Error. Dédalo is miss configured. Define DEDALO_CODE_FILES_DIR as sample.config.php defines';
				$response->errors[]	= 'Error. Bad DEDALO_CODE_FILES_DIR';
				return $response;
			}

		// Version
		// client needs to provide his own version of Dédalo
		// only compatible code files with the caller version will be provided
		// if the client doesn't send a valid version will be refuse the call.
			$string_version	= $options->version;
			$ar_version 	= explode( '.', $string_version );

			foreach($ar_version as $key => $version_number){
				if($key > 2){
					break;
				}
				$check = is_numeric( $version_number );
				if (!$check) {
					$response->msg		= 'Error. Invalid version number';
					$response->errors[]	= 'Invalid version number';
					return $response;
				}
			}

		// code
		// client needs to provide a valid code.
		// valid code is defined in config.php constant of CODE_SERVERS
			$code = $options->code;

			$code_servers = defined('CODE_SERVERS') && !empty(CODE_SERVERS)
				? CODE_SERVERS
				: [];

			$valid_code = false;
			foreach ( $code_servers as $current_server_info ) {
				if( $current_server_info['code'] === $code ){
					$valid_code = true;
					break;
				}
			}

			if( $valid_code === false ){
				$response->msg		= 'Error. Invalid code';
				$response->errors[]	= 'Invalid code';
				return $response;
			}

			$client_version = [];
				$client_version[0] = (int)$ar_version[0];
				$client_version[1] = (int)$ar_version[1];
				$client_version[2] = (int)$ar_version[2];

		// Client made a valid request.
		// get the information to be provided to client
			$response = update_code::get_code_update_info( $client_version );


		return $response;
	}//end get_ontology_update_info




	// private methods ///////////////////////////////////



	/**
	* ERROR_NUMBER_TO_TEXT
	* @param int $f_error_number
	* @return string $f_error_text
	*/
	private static function error_number_to_text(int $f_error_number) : string {

		if( $f_error_number===0 ) {
						 // all is OK
						 $f_error_text = label::get_label('file_uploaded_successfully');
		}else{
			switch($f_error_number) {
						 // Error by number
				case 1 : $f_error_text = label::get_label('uploaded_file_exceeds_the_directive');	break;
				case 2 : $f_error_text = label::get_label('uploaded_file_exceeds_the_maximum_size');	break;
				case 3 : $f_error_text = label::get_label('uploaded_file_was_only_partially_uploaded');	break;
				case 4 : $f_error_text = label::get_label('no_file_was_uploaded');	break;
				case 6 : $f_error_text = label::get_label('temp_dir_not_accessible');	break;
				case 7 : $f_error_text = label::get_label('failed_to_write_file_to_disk');	break;
				case 8 : $f_error_text = label::get_label('php_extension_stopped_the_upload_file');	break;
			}
		}

		return $f_error_text;
	}//end error_number_to_text



	/**
	* GET_KNOWN_MIME_TYPES
	* @return array $mime_types
	*/
	private static function get_known_mime_types() : array {

		$mime_types = array(
			[
				'mime'		=> 'text/plain',
				'extension'	=> ['txt','glsl']
			],
			[
				'mime'		=> 'text/html',
				'extension'	=> ['html','htm','php']
			],
			[
				'mime'		=> 'text/css',
				'extension'	=> ['css','csv']
			],
			[
				'mime'		=> 'application/javascript',
				'extension'	=> ['js']
			],
			[
				'mime'		=> 'application/json',
				'extension'	=> ['json']
			],
			[
				'mime'		=> 'application/xml',
				'extension'	=> ['xml']
			],
			[
				'mime'		=> 'application/x-shockwave-flash',
				'extension'	=> ['swf']
			],
			[
				'mime'		=> 'video/x-flv',
				'extension'	=> ['flv']
			],
			[
				'mime'		=> 'video/x-flv',
				'extension'	=> ['flv']
			],
			// images
			[
				'mime'		=> 'image/png',
				'extension'	=> ['png']
			],
			[
				'mime'		=> 'image/jpeg',
				'extension'	=> ['jpe','jpeg','jpg']
			],
			[
				'mime'		=> 'image/gif',
				'extension'	=> ['gif']
			],
			[
				'mime'		=> 'image/bmp',
				'extension'	=> ['bmp']
			],
			[
				'mime'		=> 'image/vnd.microsoft.icon',
				'extension'	=> ['ico']
			],
			[
				'mime'		=> 'image/tiff',
				'extension'	=> ['tiff','tif']
			],
			[
				'mime'		=> 'image/svg+xml',
				'extension'	=> ['svg','svgz']
			],
			[
				'mime'		=> 'image/heic',
				'extension'	=> ['heic']
			],
			[
				'mime'		=> 'image/avif',
				'extension'	=> ['avif']
			],
			[
				'mime'		=> 'image/webp',
				'extension'	=> ['webp']
			],
			// archives
			[
				'mime'		=> 'application/zip',
				'extension'	=> ['zip']
			],
			[
				'mime'		=> 'application/x-rar-compressed',
				'extension'	=> ['rar']
			],
			[
				'mime'		=> 'application/octet-stream',
				'extension'	=> ['blob','fbx','obj','glb']
			],
			[
				'mime'		=> 'application/x-msdownload',
				'extension'	=> ['exe','msi']
			],
			[
				'mime'		=> 'application/vnd.ms-cab-compressed',
				'extension'	=> ['cab']
			],
			[
				'mime'		=> 'application/marc',
				'extension'	=> ['mrc']
			],
			// audio/video
			[
				'mime'		=> 'audio/mpeg',
				'extension'	=> ['mp3']
			],
			[
				'mime'		=> 'video/mp4',
				'extension'	=> ['mp4','mp4v','mpg4']
			],
			[
				'mime'		=> 'video/quicktime',
				'extension'	=> ['qt','mov']
			],
			[
				'mime'		=> 'video/mpeg',
				'extension'	=> ['m2v','mpa','mpe','mpeg','mpg']
			],
			[
				'mime'		=> 'video/x-m4v',
				'extension'	=> ['m4v']
			],
			[
				'mime'		=> 'video/ogg',
				'extension'	=> ['ogv']
			],
			[
				'mime'		=> 'video/x-matroska',
				'extension'	=> ['mkv']
			],
			[
				'mime'		=> 'video/x-msvideo',
				'extension'	=> ['avi']
			],
			[
				'mime'		=> 'video/jpeg',
				'extension'	=> ['jpgv']
			],
			[
				'mime'		=> 'video/webm',
				'extension'	=> ['webm']
			],
			[
				'mime'		=> 'audio/x-wav',
				'extension'	=> ['wav']
			],
			// 3d @see https://github.com/KhronosGroup/glTF/blob/main/specification/1.0/README.md#mimetypes
			[
				'mime'		=> 'model/gltf-binary',
				'extension'	=> ['glb']
			],
			[
				'mime'		=> 'model/gltf+json',
				'extension'	=> ['gltf']
			],
			[
				'mime'		=> 'model/vnd.collada+xml',
				'extension'	=> ['dae']
			],
			// adobe
			[
				'mime'		=> 'application/pdf',
				'extension'	=> ['pdf']
			],
			[
				'mime'		=> 'image/vnd.adobe.photoshop',
				'extension'	=> ['psd']
			],
			[
				'mime'		=> 'application/postscript',
				'extension'	=> ['ai','eps','ps']
			],
			// ms office
			[
				'mime'		=> 'application/msword',
				'extension'	=> ['doc']
			],
			[
				'mime'		=> 'application/rtf',
				'extension'	=> ['rtf']
			],
			[
				'mime'		=> 'application/vnd.ms-excel',
				'extension'	=> ['xls']
			],
			[
				'mime'		=> 'application/vnd.ms-powerpoint',
				'extension'	=> ['ppt']
			],
			[
				'mime'		=> 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
				'extension'	=> ['pptx']
			],
			// open office
			[
				'mime'		=> 'application/vnd.oasis.opendocument.text',
				'extension'	=> ['odt']
			],
			[
				'mime'		=> 'application/vnd.oasis.opendocument.spreadsheet',
				'extension'	=> ['ods']
			],
			[
				'mime'		=> 'application/pages',
				'extension'	=> ['pages']
			],
			[
				'mime'		=> 'application/vnd.apple.keynote',
				'extension'	=> ['key']
			],
			[
				'mime'		=> 'application/vnd.apple.numbers',
				'extension'	=> ['numbers']
			],
			// geojson
			[
				'mime'		=> 'application/geo+json',
				'extension'	=> ['geojson']
			],
			[
				'mime'		=> 'application/vnd.google-earth.kml+xml',
				'extension'	=> ['kml']
			],
			[
				'mime'		=> 'application/vnd.google-earth.kmz',
				'extension'	=> ['kmz']
			]
		);


		return $mime_types;
	}//end get_known_mime_types



	/**
	* IS_VALID_KEY_DIR
	* Checks a basenamed key_dir. basename() keeps '.' and '..', that would
	* resolve to the user dir or the shared upload root
	* @param string $key_dir
	* @return bool
	*/
	private static function is_valid_key_dir(string $key_dir) : bool {

		return !in_array($key_dir, ['', '.', '..'], true);
	}//end is_valid_key_dir



	/**
	* CREATE_THUMBNAIL
	* Used by tool_import_files to create temporal thumbnails in list
	* of uploaded files
	* @see dd_utils_api::upload
	* @param object $options
	* @return string $thumbnail_url
	*/
	private static function create_thumbnail(object $options) : ?string {

		// options
			$tmp_dir		= $options->tmp_dir;
			$name			= $options->name;
			$target_path	= $options->target_path;
			$key_dir		= $options->key_dir;
			$user_id		= $options->user_id;

		// thumbnail_file
			$pathinfo		= pathinfo($name);
			$filename		= $pathinfo['filename'];
			$thumbnail_file	= $tmp_dir . '/thumbnail/' . $filename . '.jpg';

		// convert based on mime type
			$mime		= mime_content_type($target_path);
			$ar_mime	= explode('/', $mime);
			$file_type	= $ar_mime[0] ?? null;

			switch (true) {

				case ($mime==='application/pdf'):
					ImageMagick::convert((object)[
						'source_file'	=> $target_path,
						'ar_layers'		=> [0],
						'target_file'	=> $thumbnail_file,
						'density'		=> 72,
						'antialias'		=> true,
						'quality'		=> 50,
						'resize'		=> '12.5%'
					]);
					break;

				case ($file_type==='image'):
					ImageMagick::convert((object)[
						'source_file'	=> $target_path,
						'target_file'	=> $thumbnail_file,
						'thumbnail'		=> true
					]);
					break;

				case ($file_type==='video'):
					Ffmpeg::create_posterframe((object)[
						'timecode'				=> '10', // like '10'
						'src_file'				=> $target_path,
						'quality'				=> 'thumbnail',
						'posterframe_filepath'	=> $thumbnail_file
					]);
					break;

				default:
					// Nothing to do with videos
					return null;
			}

		// temp thumb file URL
		$thumbnail_url = DEDALO_UPLOAD_TMP_URL .'/'. $user_id .'/'. $key_dir .'/thumbnail/'. $filename . '.jpg';


		return $thumbnail_url;
	}//end create_thumbnail



}//end dd_utils_api
