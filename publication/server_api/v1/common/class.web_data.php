<?php
$root_dir = dirname(__FILE__, 5);
// includes server api
include(dirname(__FILE__).'/class.ts_term.php');
include(dirname(__FILE__).'/class.indexation_node.php');
include_once(dirname(__FILE__).'/class.tags_mask.php');
include(dirname(__FILE__).'/class.free_node.php');
include(dirname(__FILE__).'/class.full_node.php');
include(dirname(__FILE__).'/class.video_view_data.php');
include(dirname(__FILE__).'/class.map.php');
include(dirname(__FILE__).'/class.process_result.php');
include(dirname(__FILE__).'/class.image.php');
include(dirname(__FILE__).'/class.notes.php');
include(dirname(__FILE__).'/class.biblio.php');
// include(dirname(__FILE__).'/class.DBi.php'); // already included from config
// shared
include_once $root_dir . '/shared/class.OptimizeTC.php';
include_once $root_dir . '/shared/class.subtitles.php';
include_once $root_dir . '/shared/class.TR.php';
/**
* WEB_DATA
* Manage web source data with mysql
*
* Esta clase es genérica y debe servir también para las partes públicas.
* Cuando se use fuera de Dédalo, copiar este fichero.
* Para poder aprovechar las mejoras y corrección de errores del desarrollo de Dédalo, llevar control de versión de esta clase.
*
*/
class web_data {



	// Version. Important!
		// static $version = "1.0.33";	// 27-04-2021 last v5 version
		static $version = "1.0.34";		// 25-03-2023 First v6 implementation



	/**
	* GET_DB_CONNECTION
	* @return object $mysql_conn
	*/
	public static function get_db_connection($db_name=false) {

		if (!empty($db_name)) {

			// Requested database
				$database = $db_name;

			if (!self::check_safe_value('db_name', $db_name)) {
				die("Error. Illegal database name: ".$db_name);
			}

		}else{
			// Custom database defined in api server check
				if (defined('MYSQL_WEB_DATABASE_CONN')) {
					$database = MYSQL_WEB_DATABASE_CONN;
				}else{
					$database = MYSQL_DEDALO_DATABASE_CONN;
				}
		}

		$mysql_conn = DBi::_getConnection_mysql(
			MYSQL_DEDALO_HOSTNAME_CONN,
			MYSQL_DEDALO_USERNAME_CONN,
			MYSQL_DEDALO_PASSWORD_CONN,
			$database,
			MYSQL_DEDALO_DB_PORT_CONN,
			MYSQL_DEDALO_SOCKET_CONN
	 	);

		// $mysql_conn = web_data::get_PDO_connection(
		// 	MYSQL_DEDALO_HOSTNAME_CONN,
		// 	MYSQL_DEDALO_USERNAME_CONN,
		// 	MYSQL_DEDALO_PASSWORD_CONN,
		// 	$database,
		// 	MYSQL_DEDALO_DB_PORT_CONN,
		// 	MYSQL_DEDALO_SOCKET_CONN
		// );

		return $mysql_conn;
	}//end get_db_connection



	/**
	* GET_PDO_CONNECTION
	* @return resource $dbh
	*/
	public static function get_PDO_connection($host=null, $user=null, $password=null, $database=null, $port=null, $socket=null) {

		$host		= !empty($host) ? $host : MYSQL_DEDALO_HOSTNAME_CONN;
		$user		= !empty($user) ? $user : MYSQL_DEDALO_USERNAME_CONN;
		$password	= !empty($password) ? $password : MYSQL_DEDALO_PASSWORD_CONN;
		$database	= !empty($database)
			? $database
			: (defined('MYSQL_WEB_DATABASE_CONN') ? MYSQL_WEB_DATABASE_CONN : MYSQL_DEDALO_DATABASE_CONN);
		$port		= !empty($port) ? $port : MYSQL_DEDALO_DB_PORT_CONN;
		$socket		= !empty($socket) ? $socket : MYSQL_DEDALO_SOCKET_CONN;

		// dsn
			$ar_dsn = [];
			// dbname
			if (isset($database)) {
				$ar_dsn[] = 'dbname='.$database;
			}
			// host
			if (isset($host)) {
				$ar_dsn[] = 'host='.$host;
			}
			// port
			if (isset($port)) {
				$ar_dsn[] = 'port='.$port;
			}
			// unix_socket
			if (isset($socket)) {
				$ar_dsn[] = 'unix_socket='.$socket;
			}
			// utf8 charset
			$ar_dsn[] = 'charset=utf8mb4';

			$dsn = 'mysql:' . implode(';', $ar_dsn);

		// connect
			try {

				// $dbh = new PDO('mysql:host='.$host.';port='.$port.';dbname='.$database.';charset=utf8', $user, $password);
				$dbh = new PDO($dsn, $user, $password);
				$dbh->setAttribute(PDO::ATTR_EMULATE_PREPARES, false);
				$dbh->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

			}catch(PDOException $pe){
				// trigger_error($pe->getMessage());
				debug_log(__METHOD__." PDOException:  ".$pe->getMessage(), logger::ERROR);
			}


		return $dbh;
	}//end get_PDO_connection



	/**
	* FIND_EQUALITY
	* @param string $value
	* @return bool
	*/
	public static function find_equality($value) {

		$equality = false;
		// $pre_items = explode(' AND ', $value);
		$pre_items = preg_split('/ AND /i', $value);
		foreach ($pre_items as $pre_value) {
			$pre_value	= str_replace(['(',')','\''], '', $pre_value);
			$items		= explode(' ', $pre_value);
			foreach ($items as $c_value) {
				$c_value	= trim($c_value);
				$beats		= explode('=', $c_value);
				if (!empty($beats[0]) && !empty($beats[1])) {
					$equality = trim($beats[0])==trim($beats[1]);
					if ($equality===true) {
						break 2;
					}
				}
			}
		}
		if ($equality!==false) {
			error_log("FIND_EQUALITY ERROR -- ".$value);
			return false;
		}
		// error_log("FIND_EQUALITY OK -- ".$value);

		return $equality;
	}//end find_equality



	/**
	* CHECK_SAFE_VALUE
	* @return bool
	*/
	public static function check_safe_value($name, $value, $is_literal=false) {

		switch ($name) {

			case 'table':
				$value = is_array($value) ? implode(',', $value) : $value;
				preg_match('/^[a-zA-Z|_|,]{2,}.*$/i', $value, $output_array);
				if (empty($output_array[0])) {
					debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
					return false;
				}
				break;

			case 'db_name':
				preg_match('/^[a-zA-Z0-9|_]{2,}$/i', $value, $output_array);
				if (empty($output_array[0])) {
					debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
					return false;
				}
				break;

			case 'ar_fields':
				$plain_fields = is_array($value)
					? implode(',', $value)
					: $value;

				// equality check
					if (web_data::find_equality($plain_fields)!==false) {
						return false;
					}

				// valid chars check
					$ar_value = !is_array($value) ? explode(',', $value) : $value;
					foreach ($ar_value as $c_value) {

						if($is_literal===true) {
							// free search case
							preg_match('/^[\w|,|\+| |`|\'|\(|\)|\*|\\\|"]+$/iu', $c_value, $output_array);

						}else if (strpos($c_value, 'CONCAT')===0) {
							// added |\"|\[|\] to allow CONCAT sentences (14-10-2021)
							# preg_match('/^[a-zA-Z0-9|_|,|\+| |`|\'|\"|\[|\]|\(|\)|\*]+$/i', $c_value, $output_array);
							// added '/u' to allow all unicode chars (ñ for example)
							// changed '[a-zA-Z0-9|_' to the equivalent '\w'
							preg_match('/^[\w|,|\+| |`|\'|\"|\[|\]|\(|\)|\*]+$/iu', $c_value, $output_array);

						}else{
							# preg_match('/^[a-zA-Z0-9|_|,|\+| |`|\'|\(|\)|\*]+$/i', $c_value, $output_array);
							// added '/u' to allow all unicode chars (ñ for example)
							// changed '[a-zA-Z0-9|_' to the equivalent '\w'
							preg_match('/^[\w|,|\+| |`|\'|\(|\)|\*]+$/iu', $c_value, $output_array);
						}

						if (empty($output_array[0])) {
							debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
							return false;
						}
					}
					// old
						// preg_match('/^[a-zA-Z0-9|_|,|\+| |`|\'|\(|\)|\*]+$/i', $plain_fields, $output_array);
						// if (empty($output_array[0])) {
						// 	return false;
						// }
				break;

			case 'sql_fullselect':

				// equality check
					if (web_data::find_equality($value)!==false) {
						return false;
					}

				preg_match_all("/=|delete|update|insert|truncate|extractvalue|\*{2,}|MD5|DBMS_PIPE| union |set names|where|user|having|\-\-|delay|sleep|outfile|\@\@|information_schema| if | if\(|mysql/i", $value, $output_array);
				if (!empty($output_array[0])) {
					debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
					return false;
				}
				break;

			case 'sql_filter':

				// equality check
					if (web_data::find_equality($value)!==false) {
						return false;
					}

				preg_match_all("/select |delete|update|insert|includes|wlwmanifest|truncate|extractvalue|\*{2,}|MD5|DBMS_PIPE| union |set names|where|having|user|\-\-|delay|sleep|outfile|\@\@|information_schema| if | if\(|mysql/i", $value, $output_array);
				if (!empty($output_array[0])) {
					debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
					return false;
				}
				break;

			case 'lang':
				preg_match('/^lg-[a-z]{2,5}$/i', $value, $output_array);
				if (empty($output_array[0])) {
					debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
					return false;
				}
				break;

			case 'section_id':
				preg_match('/^[0-9|,| |]+$/i', $value, $output_array);
				if (empty($output_array[0])) {
					debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
					return false;
				}
				break;

			case 'order':
				preg_match('/^[a-z0-9|,| |`|_|\(|\)]+$/i', $value, $output_array);
				if (empty($output_array[0])) {
					debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
					return false;
				}
				break;

			case 'group':
				if (strpos($value, 'CONCAT')===0) {
					// added |\"|\[|\] to allow CONCAT sentences (28-03-2022)
					preg_match('/^[\w|,|\+| |`|\'|\"|\[|\]|\(|\)|\*]+$/iu', $value, $output_array);
					if (empty($output_array[0])) {
						return false;
					}
				}else{

					preg_match('/^[a-z| |`|,|_]+$/i', $value, $output_array);
					if (empty($output_array[0])) {
						debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
						return false;
					}
				}
				break;

			case 'limit':
			case 'offset':
				preg_match('/^[0-9]+$/i', $value, $output_array);
				if (empty($output_array[0])) {
					debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
					return false;
				}
				break;

			case 'term_id':
			case 'section_tipo':
				preg_match('/^[a-z1-9|_]+$/i', $value, $output_array);
				if (empty($output_array[0])) {
					debug_log(__METHOD__." test $name not passed! ".to_string($output_array), logger::ERROR);
					return false;
				}
				break;

			default:
				debug_log(__METHOD__." test $name not passed! ".to_string(), logger::ERROR);
				return false;
				break;
		}

		return true;
	}//end check_safe_value



	/* ROWS_DATA (SQL)
	----------------------------------------------------------------------- */

		/**
		* GET_ROWS_DATA
		* Función genérica de consulta a las tablas de difusión generadas por Dédalo tras la publicación web
		* Devuelve array con los rows de los campos solicitados
		* @param object $request_options . Object with options like table, ar_fields, lang, etc..
		* @return object $response
		*/
		public static function get_rows_data( $request_options ) : object {
			// error_log('get_rows_data request_options: '.PHP_EOL. json_encode($request_options));
			$start_time = microtime(1);

			$response = new stdClass();
				$response->result = false;
				$response->msg    = "Error on get data";

			// Options defaults
				$sql_options = new stdClass();
					$sql_options->table						= null;
					$sql_options->ar_fields					= array('*');
					$sql_options->sql_fullselect			= false; // default false
					$sql_options->section_id				= false;
					$sql_options->sql_filter				= ''; 	// publicacion = 'si'
					$sql_options->ignore_tags				= true; // bool. If true, LIKE filters on tagged text columns ignore tag contents
					$sql_options->is_literal				= false; // default is false
					$sql_options->lang						= null;	// WEB_CURRENT_LANG_CODE;
					$sql_options->order						= '`id` ASC';
					$sql_options->group						= false;
					$sql_options->limit						= 0;
					$sql_options->offset					= false;
					$sql_options->count						= false;
					$sql_options->resolve_portal			= false; // bool
					$sql_options->resolve_dd_relations 		= false; // bool
					$sql_options->resolve_portals_custom	= false; // array | bool
					$sql_options->apply_postprocess			= false; //  bool default true
					$sql_options->map						= false; //  object | bool (default false). Apply map function to value like [{"field":birthplace_id","function":"resolve_geolocation","otuput_field":"birthplace_obj"}]
					$sql_options->process_result			= false;
					$sql_options->db_name					= false;
					$sql_options->conn						= false;
					$sql_options->caller					= 'default';

					foreach ($request_options as $key => $value) {if (property_exists($sql_options, $key)) $sql_options->$key = $value;}

			// ar_fields verify json encoded array (14-10-2021)
				if (is_string($sql_options->ar_fields) && strpos($sql_options->ar_fields, '[')===0) {
					// try to decode json formatted array
					if ($decoded_array = json_decode($sql_options->ar_fields)) {
						$sql_options->ar_fields = $decoded_array;
					}
				}

			// table check
				if (empty($sql_options->table) && empty($sql_options->sql_fullselect)) {
					$response->result = false;
					$response->msg    = "Empty options->table ";
					return $response;
				}else{
					if (!self::check_safe_value('table', $sql_options->table)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal table (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : $sql_options->table";
						}
						return $response;
					}
				}

			// ar_fields check
				if (!empty($sql_options->ar_fields)) {
					if (!self::check_safe_value('ar_fields', $sql_options->ar_fields, $sql_options->is_literal)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal ar_fields (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : ".to_string($sql_options->ar_fields);
						}
						return $response;
					}
				}

			// sql_fullselect check
				if (!empty($sql_options->sql_fullselect)) {
					if (!self::check_safe_value('sql_fullselect', $sql_options->sql_fullselect)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal sql_fullselect option (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : $sql_options->sql_fullselect";
						}
						return $response;
					}
				}

			// section_id
				if (!empty($sql_options->section_id)) {
					if (!self::check_safe_value('section_id', $sql_options->section_id)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal section_id option (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : $sql_options->section_id";
						}
						return $response;
					}
				}

			// sql_filter check
				if (!empty($sql_options->sql_filter)) {

					// sanitize $sql_options->sql_filter
						// $conn = web_data::get_db_connection($sql_options->db_name);
						// $sql_options->sql_filter = mysqli_real_escape_string($conn, $sql_options->sql_filter);

					if (!self::check_safe_value('sql_filter', $sql_options->sql_filter)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal sql_filter option (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : $sql_options->sql_filter";
						}
						return $response;
					}
				}

			// lang check
				if(!empty($sql_options->lang)) {
					if (!self::check_safe_value('lang', $sql_options->lang)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal lang (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : $sql_options->lang";
						}
						return $response;
					}
				}

			// order check
				if(!empty($sql_options->order)) {
					if (!self::check_safe_value('order', $sql_options->order)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal order (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : $sql_options->order";
						}
						return $response;
					}
				}

			// group check
				if(!empty($sql_options->group)) {
					if (!self::check_safe_value('group', $sql_options->group)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal group (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : $sql_options->group";
						}
						return $response;
					}
				}

			// limit check
				if(!empty($sql_options->limit)) {
					if (!self::check_safe_value('limit', $sql_options->limit)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal limit (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : $sql_options->limit";
						}
						return $response;
					}
				}

			// offset check
				if(!empty($sql_options->offset)) {
					if (!self::check_safe_value('offset', $sql_options->offset)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal offset (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : $sql_options->offset";
						}
						return $response;
					}
				}

			// db_name check
				if(!empty($sql_options->db_name)) {
					if (!self::check_safe_value('db_name', $sql_options->db_name)) {
						$response->result = false;
						$response->msg    = "Error on sql request. Illegal db_name (1)";
						if(SHOW_DEBUG===true) {
							$response->msg   .= " : $sql_options->db_name";
						}
						return $response;
					}
				}


			// debug
				// dump($sql_options, ' sql_options ++ '.to_string());
				// dump(json_encode($sql_options, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT), ' sql_options->resolve_portal ++ '.to_string());

			// section_id filter
				if ($sql_options->section_id!==false && !empty($sql_options->section_id)) {

					// parse as array always
						$ar_section_id = explode(',', $sql_options->section_id);
						$ar_sentences  = array_map(function($current_section_id){
							return 'section_id=' . (int)$current_section_id;
						}, $ar_section_id);
						$current_sql_filter = '(' . implode(' OR ', $ar_sentences) .')';

					// add sql_filter if not empty
						if (!empty($sql_options->sql_filter)) {
							$current_sql_filter .= ' AND ' . $sql_options->sql_filter;
						}

					$sql_options->sql_filter = $current_sql_filter;
				}

			// fields. Convert text ar_fields to array
				if (!is_array($sql_options->ar_fields)) {
					$sql_options->ar_fields = explode(',', $sql_options->ar_fields );
					$sql_options->ar_fields = array_map('trim', $sql_options->ar_fields);
				}

			// strQuery
				$strQuery = '';

			// info query
				$strQuery .= '-- '  .__METHOD__;
				$strQuery .= ' -- caller: ' . $sql_options->caller;

			// With prepare statement
				// $stmt = mysqli_prepare($link, "INSERT INTO table VALUES ('PHP', ?, ?)");
				// 	mysqli_stmt_bind_param($stmt, "iis", $integer, $code, $string);
				// 	mysqli_stmt_execute($stmt);

				if ($sql_options->sql_fullselect) {

					# Full select like "SELECT id,section_id,titulo,mupreva830 FROM publicaciones UNION SELECT id,section_id,titulo,mupreva830 FROM publicaciones_externas"
					$strQuery .= PHP_EOL . $sql_options->sql_fullselect;

					# WHERE
					$strQuery .= PHP_EOL . self::build_sql_where($sql_options->lang, $sql_options->sql_filter, $sql_options->ignore_tags);

				}else{

					$ar_tables = !is_array($sql_options->table) ? (array)explode(',', $sql_options->table) : (array)$sql_options->table;
					$ar_tables = array_map('trim', $ar_tables);

					$end_table = end($ar_tables);
					foreach ($ar_tables as $table) {

						# SELECT
						$strQuery .= PHP_EOL . self::build_sql_select($sql_options->ar_fields);

						# FROM
						$strQuery .= PHP_EOL . self::build_sql_from($table);

						# WHERE
						$strQuery .= PHP_EOL . self::build_sql_where($sql_options->lang, $sql_options->sql_filter, $sql_options->ignore_tags);

						# GROUP
						if(!empty($sql_options->group)) {
							$strQuery .= PHP_EOL . self::build_sql_group($sql_options->group);
						}

						# UNION
						if ($table!==$end_table) {
						$strQuery .= PHP_EOL . 'UNION ALL ';
						}
					}
				}

				// order
					if(!empty($sql_options->order)) {
						$strQuery .= PHP_EOL . self::build_sql_order($sql_options->order);
					}

				// limit
					if(!empty($sql_options->limit)) {
						$strQuery .= PHP_EOL . self::build_sql_limit($sql_options->limit, $sql_options->offset);
					}

			// set final strQuery
				// $sql_options->strQuery = $strQuery;
					#dump($strQuery, ' strQuery ++ '.to_string());
					// error_log('get_rows_data: '.PHP_EOL.$strQuery);

			// exec query
				$query_options = new stdClass();
					$query_options->strQuery				= $strQuery;
					$query_options->caller					= $sql_options->caller;
					$query_options->count					= $sql_options->count;
					$query_options->ar_fields				= $sql_options->ar_fields;
					$query_options->resolve_portal			= $sql_options->resolve_portal;
					$query_options->resolve_dd_relations	= $sql_options->resolve_dd_relations;
					$query_options->resolve_portals_custom	= $sql_options->resolve_portals_custom;
					$query_options->portal_filter			= $sql_options->portal_filter ?? false;
					$query_options->table					= $sql_options->table;
					$query_options->apply_postprocess		= $sql_options->apply_postprocess;
					$query_options->map						= $sql_options->map;
					$query_options->process_result			= $sql_options->process_result;
					$query_options->lang					= $sql_options->lang;
					$query_options->db_name					= $sql_options->db_name ?? MYSQL_WEB_DATABASE_CONN ?? null;
					$query_options->conn					= $sql_options->conn;
					$query_options->sql_options				= $sql_options; // full used options here

				$exec_query_response = self::exec_query($query_options);
					#dump($exec_query_response, ' exec_query_response ++ '.to_string());

			// response
				$response->result	= $exec_query_response->result;
				$response->total	= $exec_query_response->total ?? false;
				$response->msg		= 'OK get rows_data done. ' . $exec_query_response->msg;

			// debug
				$response->debug = (isset($exec_query_response->debug))
					? $exec_query_response->debug
					: new stdClass();

				$response->debug->total_time = round(microtime(1)-$start_time,3);

			return $response;
		}//end get_rows_data



		/**
		* GET_BIBLIOGRAPHY_ROWS
		*	Special bibliography (publications) records request
		*	Sorts in custom way using author name using special columns (author_main, author_others, authors_count)
		* @param object $request_options
		* @return object $response
		*/
		public static function get_bibliography_rows($request_options) {

			$response = new stdClass();
				$response->result = false;
				$response->msg    = "Error on get data";

			// Reference
				// (SELECT * , 0 as ordinal
				// FROM publications
				// WHERE lang = 'lg-spa' AND author_main LIKE '%ripolles%')
				// UNION ALL
				// (SELECT *, 1 as ordinal
				// FROM publications
				// WHERE lang = 'lg-spa' AND author_others LIKE '%ripolles%')
				// ORDER BY ordinal, case authors_count when 1 then 1 else 2 end, author_main, author_others, publication_date;

			// Options defaults
				$sql_options = new stdClass();
					$sql_options->table						= 'publications';
					$sql_options->ar_fields					= ['*'];
					$sql_options->sql_filter				= '';
					$sql_options->use_union					= false; // default false
					$sql_options->lang						= null;
					$sql_options->limit						= 0;
					$sql_options->offset					= false;
					$sql_options->count						= false;
					$sql_options->resolve_portal			= false; // bool
					$sql_options->resolve_portals_custom	= false; // array | bool
					$sql_options->apply_postprocess			= false;
					$sql_options->map						= false;
					$sql_options->process_result			= false;
					$sql_options->db_name					= false;
					$sql_options->conn						= false;
					$sql_options->caller					= 'bibliography_rows';

					foreach ($request_options as $key => $value) {if (property_exists($sql_options, $key)) $sql_options->$key = $value;}

			// strQuery
				$strQuery = '';

			// select
				$strQuery .= PHP_EOL . 'SELECT '.implode(',', $sql_options->ar_fields).', 0 as ordinal';

			// from
				$strQuery .= PHP_EOL . 'FROM '.$sql_options->table;

			// where base
				$where_base = 'WHERE `lang`=\''.$sql_options->lang.'\' ';

			// authors conditions union
				if ($sql_options->use_union===true) {

					// where
						$strQuery .= PHP_EOL . $where_base;
						if (!empty($sql_options->sql_filter)) {

							$current_filter = strpos($sql_options->sql_filter, 'AND')===0
								? $sql_options->sql_filter
								: 'AND ' . $sql_options->sql_filter;

							// author_main search case (replaces 'authors')
								$strQuery .= str_replace('authors', 'author_main', $current_filter);
						}

					// union
						$strQuery .= PHP_EOL . 'UNION ALL';

					// select 2
						$strQuery .= PHP_EOL . 'SELECT '.implode(',', $sql_options->ar_fields).', 1 as ordinal';

					// from 2
						$strQuery .= PHP_EOL . 'FROM '.$sql_options->table;

					// where
						$strQuery .= PHP_EOL . $where_base;
						if (!empty($sql_options->sql_filter)) {

							$current_filter = strpos($sql_options->sql_filter, 'AND')===0
								? $sql_options->sql_filter
								: 'AND ' . $sql_options->sql_filter;
							// author_main search case (replaces 'authors')
								$strQuery .= str_replace('authors', 'author_others', $current_filter);
						}

				}else{

					// where
						$strQuery .= PHP_EOL . $where_base;
						if (!empty($sql_options->sql_filter)) {

							$current_filter = strpos($sql_options->sql_filter, 'AND')===0
								? '('. $sql_options->sql_filter .')'
								: 'AND ' .'('. $sql_options->sql_filter .')';

							$strQuery .= $current_filter;
						}
				}


			// order always fixed (!)
				$strQuery .= PHP_EOL . 'ORDER BY ordinal, case authors_count when 1 then 1 else 2 end, author_main, author_others, publication_date';

			// limit
				$strQuery .= PHP_EOL . 'LIMIT ' . (int)$sql_options->limit;

			// offset
				$strQuery .= PHP_EOL . 'OFFSET ' . (int)$sql_options->offset;

			// window
				if($sql_options->use_union===true) {
					$strQuery = 'SELECT * FROM (' . $strQuery . PHP_EOL. ') t group by section_id';
				}


			// exec query
				$query_options = new stdClass();
					$query_options->strQuery				= $strQuery;
					$query_options->caller					= $sql_options->caller;
					$query_options->count					= $sql_options->count;
					$query_options->ar_fields				= $sql_options->ar_fields;
					$query_options->resolve_portal			= $sql_options->resolve_portal;
					$query_options->resolve_portals_custom	= $sql_options->resolve_portals_custom;
					$query_options->portal_filter			= $sql_options->portal_filter ?? false;
					$query_options->table					= $sql_options->table;
					$query_options->apply_postprocess		= $sql_options->apply_postprocess;
					$query_options->map						= $sql_options->map;
					$query_options->process_result			= $sql_options->process_result;
					$query_options->lang					= $sql_options->lang;
					$query_options->db_name					= $sql_options->db_name;
					$query_options->conn					= $sql_options->conn;

				$exec_query_response = self::exec_query($query_options);


			$response->result	= $exec_query_response->result;
			$response->total	= $exec_query_response->total;
			$response->msg		= "Ok request done. " . $exec_query_response->msg;


			return $response;
		}//end get_bibliography_rows



		/**
		* EXEC_QUERY
		* @param object $options
		* @return object $response
		*/
			// private static function exec_query($options) {

			// 	$start_time = microtime(1);

			// 	$response = new stdClass();
			// 		$response->result = false;
			// 		$response->msg    = "Error on get data (exec_query)";

			// 	// sort vars
			// 		$strQuery				= $options->strQuery;
			// 		$caller					= $options->caller;
			// 		$count					= $options->count;
			// 		$ar_fields				= $options->ar_fields;
			// 		$resolve_portal			= $options->resolve_portal;
			// 		$resolve_portals_custom = $options->resolve_portals_custom ?? false;
			// 		$portal_filter			= $options->portal_filter ?? false;
			// 		$table					= $options->table;
			// 		$apply_postprocess		= $options->apply_postprocess ?? false;
			// 		$map					= $options->map ?? false;
			// 		$process_result			= $options->process_result ?? false;
			// 		$sql_options 			= $options->sql_options ?? false; // full used sql_options to build exec_query
			// 		$lang					= $options->lang;
			// 		$db_name				= !empty($options->db_name) ? $options->db_name : false;
			// 		$conn					= is_resource($options->conn) ? $options->conn : web_data::get_db_connection($db_name);

			// 	// connection check
			// 		if (empty($conn)) {
			// 			$response->result = false;
			// 			$response->msg    = "Empty connection";
			// 			return $response;
			// 		}

			// 	// safe query test
			// 		preg_match_all("/delete|update|insert/i", $strQuery, $output_array);
			// 		if (!empty($output_array[0])) {
			// 			$response->result = false;
			// 			$response->msg    = "Error on sql request. Illegal option";
			// 			if(SHOW_DEBUG===true) {
			// 				$response->msg   .= " : $strQuery";
			// 				dump($output_array[0], ' output_array[0] ++ '.to_string());
			// 			}
			// 			return $response;
			// 		}

			// 	// debug
			// 		if ($caller!=='portal_resolve') {
			// 			debug_log(__METHOD__." Executing query " . PHP_EOL . trim($strQuery), logger::DEBUG);
			// 		}

			// 	// exec mysql query
			// 		$result = $conn->query($strQuery);

			// 		if (!$result) {
			// 			# Si hay problemas en la búsqueda, no lanzaremos error ya que esta función se usa en partes públicas
			// 			$response->result = false;
			// 			$response->msg    = "Error on sql request (no result) ";
			// 			$msg = "Error processing request: ".$conn->error;
			// 			// use always silent errors to not alter json result object
			// 			error_log(__METHOD__ ." $msg ".PHP_EOL." ". to_string($strQuery) );
			// 			if(SHOW_DEBUG===true) {
			// 				$response->msg .= $msg .' - '. to_string($strQuery);
			// 			}
			// 			return $response;
			// 		}

			// 	// count records
			// 		$total = ($count===true)
			// 			? (int)web_data::count_records($strQuery, $conn)
			// 			: false;

			// 	// reset pointer
			// 		if (empty($ar_fields) || $ar_fields[0]==='*') {
			// 			$ar_fields = array_keys((array)$result->fetch_assoc());
			// 			$result->data_seek(0); # Reset pointer of fetch_assoc
			// 		}

			// 	// resolve_portals_custom like ‘{"audiovisual":"audiovisual","informant":"informant"}’
			// 		switch (true) {
			// 			case (is_string($resolve_portals_custom) && !empty($resolve_portals_custom)):
			// 				$resolve_portals_custom = json_decode($resolve_portals_custom);
			// 				break;
			// 			case (is_object($resolve_portals_custom) && !empty($resolve_portals_custom)):
			// 				// nothing to do
			// 				break;
			// 			default:
			// 				$resolve_portals_custom = false;
			// 				break;
			// 		}

			// 	// resolve_portal. publication_schema
			// 		// When options 'resolve_portal' is true, we create a virtual 'resolve_portals_custom' options
			// 		// from 'publication_schema' whith all portals
			// 		if ($resolve_portals_custom===false && $resolve_portal===true) {
			// 			$resolve_portals_custom = self::get_publication_schema($table);
			// 			// format resolve_portals_custom as object always
			// 			if (is_array($resolve_portals_custom)) {
			// 				$resolve_portals_custom = (object)$resolve_portals_custom;
			// 			}elseif (is_string($resolve_portals_custom)) {
			// 				$resolve_portals_custom = json_decode($resolve_portals_custom);
			// 			}
			// 		}

			// 	// rows iterate
			// 		$ar_data = [];
			// 		$i=0;while( $row = $result->fetch_assoc() ) {

			// 			// table is added always as first column
			// 				$ar_data[$i]['table'] = $table;

			// 			foreach($ar_fields as $current_field) {

			// 				if ($current_field==='id') {
			// 					# continue; // Skip mysql table id
			// 					# Replace id column for table name column
			// 					# If table is array, only first table is supported
			// 					// $ar_data[$i]['table'] = $table;
			// 					continue;
			// 				}

			// 				# alias case (like  floor(YEAR(fecha_inicio)/10)*10 AS decade)
			// 				if (strpos($current_field, ' AS ')!==false) {
			// 					$ar_parts = explode(' AS ', $current_field);
			// 					$current_field = trim($ar_parts[1]);
			// 				}

			// 				# field_data. postprocess_field if need
			// 				$field_data = ($apply_postprocess===true)
			// 					? self::postprocess_field($current_field, $row[$current_field])
			// 					: $row[$current_field];

			// 				# Default behaviour
			// 				$ar_data[$i][$current_field] = $field_data;

			// 				#  Portal resolve cases
			// 				if ($resolve_portals_custom!==false) {

			// 					if ( (property_exists($resolve_portals_custom, $current_field) )
			// 					  && $current_field!==$table // case field image into table image, por example
			// 					) {
			// 						// request options
			// 						$request_options = new stdClass();
			// 							$request_options->lang 			 = $lang;
			// 							$request_options->resolve_portal = $resolve_portal;
			// 							$request_options->portal_filter  = $portal_filter;
			// 							$request_options->map  			 = $map;

			// 						$ar_data[$i][$current_field] = self::portal_resolve($row,
			// 																			$current_field,
			// 																			$request_options,
			// 																			$resolve_portals_custom);
			// 					}
			// 				}//end if ($resolve_portals_custom!==false)
			// 			}

			// 		$i++;};

			// 	$result->free();
			// 	// web_data::get_db_connection()->close();


			// 	// map. Format : [{"field":birthplace_id","function":"resolve_geolocation","output_field":"birthplace_obj"}]
			// 		if ($map!==false) {
			// 			# Exec defined map functions and add columns as request
			// 			foreach ($ar_data as $key => $row) {
			// 				foreach ($map as $map_obj) {
			// 					if ($map_obj->table===$table) {
			// 						$ar_data[$key][$map_obj->output_field] = map::{$map_obj->function}($row[$map_obj->field], $lang);
			// 					}
			// 				}
			// 			}
			// 		}//end if ($map!==false)

			// 	// process_result. : function name, ar_data, process_result object, sql_options object, $total
			// 		if ($process_result!==false && !empty($ar_data)) {
			// 			$user_func_response = call_user_func($process_result->fn, $ar_data, $process_result, $sql_options);

			// 			// overwrite ar_data (!)
			// 				$ar_data = $user_func_response->ar_data;
			// 		}


			// 	// response Fixed properties
			// 		$response->result 	= $ar_data;
			// 		$response->total 	= $total ?? false;
			// 		$response->msg    	= "Ok exec_query done";

			// 	// response debug properties
			// 		if(SHOW_DEBUG===true) {
			// 			$query_parts = explode(PHP_EOL, $strQuery);
			// 			$response->debug = (object)[
			// 				'count_query' 	=> $count_query ?? false,
			// 				'strQuery' 		=> implode(' ', $query_parts),
			// 				'time' 	 		=> round(microtime(1)-$start_time,3)
			// 			];
			// 		}

			// 	// debug
			// 		if(SHOW_DEBUG===true) {
			// 			// error_log("++++++ query: " . implode(' ', $query_parts));;
			// 		}


			// 	return $response;
			// }//end exec_query



		/**
		* EXEC_QUERY
		* @param object $options
		* @return object $response
		*/
		private static function exec_query($options) {

			$start_time = microtime(1);

			$response = new stdClass();
				$response->result = false;
				$response->msg    = "Error on get data (exec_query)";

			// sort vars
				$strQuery				= $options->strQuery;
				$caller					= $options->caller;
				$count					= $options->count;
				$ar_fields				= $options->ar_fields;
				$resolve_portal			= $options->resolve_portal;
				$resolve_portals_custom	= $options->resolve_portals_custom ?? false;
				$resolve_dd_relations	= $options->resolve_dd_relations ?? false;
				$portal_filter			= $options->portal_filter ?? false;
				$table					= $options->table;
				$apply_postprocess		= $options->apply_postprocess ?? false;
				$map					= $options->map ?? false;
				$process_result			= $options->process_result ?? false;
				$sql_options			= $options->sql_options ?? false; // full used sql_options to build exec_query
				$lang					= $options->lang;
				$db_name				= !empty($options->db_name) ? $options->db_name : null;

			// safe strQuery query test
				preg_match_all("/delete|update|insert|truncate|set names|user|mysql|localhost/i", $strQuery, $output_array);
				if (!empty($output_array[0])) {
					$response->result = false;
					$response->msg    = "Error on sql request. Illegal option (exec_query)";
					if(SHOW_DEBUG===true) {
						$response->msg   .= " : $strQuery";
						dump($output_array[0], ' output_array[0] ++ '.to_string());
					}
					return $response;
				}

			// debug
				if ($caller!=='portal_resolve') {
					debug_log(__METHOD__." Executing query " . PHP_EOL . trim($strQuery), logger::DEBUG);
				}
				// if(SHOW_DEBUG===true) {
				// 	error_log("strQuery:".PHP_EOL.$strQuery);
				// }

			// prepare PDO
				try {
					$dbh = web_data::get_PDO_connection(
						MYSQL_DEDALO_HOSTNAME_CONN,
						MYSQL_DEDALO_USERNAME_CONN,
						MYSQL_DEDALO_PASSWORD_CONN,
						$db_name
					);
					$stmt	= $dbh->prepare($strQuery);
					$stmt->setFetchMode(PDO::FETCH_ASSOC);
					$result = $stmt->execute();

					$dbh = null;
				} catch (PDOException $e) {
					// print "Error!: " . $e->getMessage() . "<br/>";
					error_log(__METHOD__ ." ".PHP_EOL." ". $e->getMessage() .PHP_EOL." strQuery: ". $strQuery );
					// die();
					$response->msg .= ' Check server log for details';
					return $response;
				}

				if (!isset($result) || !$result) {
					// If there are problems in the search, we will not throw an error as this function is used in public parts.
					$response->result = false;
					$response->msg    = "Error on sql request (no result) ";
					$msg = "Error processing request (no result)";
					// use always silent errors to not alter json result object
					error_log(__METHOD__ ." $msg ".PHP_EOL." ". to_string($strQuery) );
					if(SHOW_DEBUG===true) {
						$response->msg .= $msg .' - '. to_string($strQuery, $db_name);
					}
					return $response;
				}

			// count records
				$total = ((bool)$count===true)
					? (int)web_data::count_records($strQuery, $db_name)
					: false;

			// resolve_portals_custom like ‘{"audiovisual":"audiovisual","informant":"informant"}’
				switch (true) {
					case (is_string($resolve_portals_custom) && !empty($resolve_portals_custom)):
						$resolve_portals_custom = json_decode($resolve_portals_custom);
						break;
					case (is_object($resolve_portals_custom) && !empty($resolve_portals_custom)):
						// nothing to do
						break;
					default:
						$resolve_portals_custom = false;
						break;
				}
				// invalid JSON decodes as null; only valid objects are usable below
				if (!is_object($resolve_portals_custom)) {
					$resolve_portals_custom = false;
				}

			// resolve_portal. publication_schema
				// When options 'resolve_portal' is true, we create a virtual 'resolve_portals_custom' options
				// from 'publication_schema' with all portals
				if ($resolve_portals_custom===false && $resolve_portal===true) {
					$resolve_portals_custom = self::get_publication_schema($table);
					// format resolve_portals_custom as object always
					if (is_array($resolve_portals_custom)) {
						$resolve_portals_custom = (object)$resolve_portals_custom;
					}elseif (is_string($resolve_portals_custom) && !empty($resolve_portals_custom)) {
						$resolve_portals_custom = json_decode($resolve_portals_custom);
					}
					// publication_schema table or data can be missing (get_publication_schema returns a message string, null or false)
					if (!is_object($resolve_portals_custom)) {
						error_log(__METHOD__ .' resolve_portal requested but publication_schema is not available: '. to_string($resolve_portals_custom));
						$resolve_portals_custom = false;
					}
				}

			// rows iterate
				$ar_data = [];
				$i=0;  while ($row = $stmt->fetch()) {

					if (empty($ar_fields) || $ar_fields==='*' || $ar_fields[0]==='*') {
						$ar_fields = array_keys($row);
					}

					// table is added always as first column
						$ar_data[$i]['table'] = $table;

					foreach($ar_fields as $current_field) {

						if ($current_field==='id') {
							// Skip mysql table id
							# Replace id column for table name column
							# If table is array, only first table is supported
							// $ar_data[$i]['table'] = $table;
							continue;
						}

						# alias case (like  floor(YEAR(fecha_inicio)/10)*10 AS decade)
						if (strpos($current_field, ' AS ')!==false) {
							$ar_parts = explode(' AS ', $current_field);
							$current_field = trim($ar_parts[1]);
						}

						# field_data. postprocess_field if need
							$field_data = ($apply_postprocess===true)
								? self::postprocess_field($current_field, $row[$current_field])
								: $row[$current_field] ?? null;

						# Default behavior
							$ar_data[$i][$current_field] = $field_data;

						// Portal resolve cases
							if($resolve_portals_custom!==false) {

								if ( (property_exists($resolve_portals_custom, $current_field) )
								  && $current_field!==$table // case field image into table image, for example
								) {
									// request options
									$request_options = new stdClass();
										$request_options->lang				= $lang;
										$request_options->resolve_portal	= $resolve_portal;
										$request_options->portal_filter		= $portal_filter;
										$request_options->map				= $map;

									$ar_data[$i][$current_field] = self::portal_resolve(
										$row, // array rows
										$current_field, // string field (column name)
										$request_options, // object options
										$resolve_portals_custom, // bool|string resolve_portals_custom
										false // bool resolve_dd_relations
									);
								}
							}//end if ($resolve_portals_custom!==false)

						// resolve_dd_relations
							if($resolve_dd_relations===true) {

								// request options
									$request_options = new stdClass();
										$request_options->lang				= $lang;
										$request_options->resolve_portal	= false;
										$request_options->portal_filter		= $portal_filter;
										$request_options->map				= $map;

									$current_field = 'dd_relations';
									$ar_data[$i][$current_field] = self::portal_resolve(
										$row, // array rows
										$current_field, // string field (column name)
										$request_options, // object options
										false, // bool|string resolve_portals_custom
										true // bool resolve_dd_relations
									);
							}//end if($resolve_dd_relations===true)
					}//end foreach($ar_fields as $current_field)

				$i++;};


			// map. Format : [{"field":birthplace_id","function":"resolve_geolocation","output_field":"birthplace_obj"}]
				if ($map!==false) {
					# Exec defined map functions and add columns as request
					foreach ($ar_data as $key => $row) {
						foreach ($map as $map_obj) {
							if ($map_obj->table===$table) {
								$ar_data[$key][$map_obj->output_field] = map::{$map_obj->function}($row[$map_obj->field], $lang);
							}
						}
					}
				}//end if ($map!==false)

			// process_result. : function name, ar_data, process_result object, sql_options object, $total
				// received format:
				// {
				//		fn 		: 'process_result::add_parents_and_children_recursive',
				//		columns : [{name : "parents"}]
				// }
				if ($process_result!==false && !empty($ar_data)) {
					$process_result = is_string($process_result) && !empty($process_result)
						? json_decode($process_result)
						: $process_result;
					if (isset($process_result->fn)) {
						$ar_call = explode('::', $process_result->fn);
						if(true===method_exists($ar_call[0],$ar_call[1])) {

							// exec method in class 'process_result' like process_result::break_down_totals
							$user_func_response = call_user_func($process_result->fn, $ar_data, $process_result, $sql_options);

							// overwrite ar_data (!)
							$ar_data = $user_func_response->ar_data;

						}else{
							debug_log(__METHOD__." Method received to process_result ('$process_result->fn') do not exists! Ignored process (1). ".to_string(), logger::ERROR);
						}
					}else{
						debug_log(__METHOD__." Method received to process_result ('$process_result->fn') do not exists! Ignored process (2). ".to_string(), logger::ERROR);
					}
				}

			// response Fixed properties
				$response->result 	= $ar_data;
				$response->total 	= $total ?? false;
				$response->msg    	= "Ok exec_query done";

			// response debug properties
				if(SHOW_DEBUG===true) {
					$query_parts = explode(PHP_EOL, $strQuery);
					$response->debug = (object)[
						'count_query'	=> $count_query ?? false,
						'strQuery'		=> implode(' ', $query_parts),
						'time'			=> round(microtime(1)-$start_time,3)
					];
				}

			// debug info time execution
				// $total_time = round(microtime(1)-$start_time,3);
				// error_log("++++++ strQuery [$total_time ms]: " . $strQuery);

			// debug
				if(SHOW_DEBUG===true) {
					// error_log("++++++ query: " . implode(' ', $query_parts));;
				}


			return $response;
		}//end exec_query



		/**
		* BUILD_SQL_SELECT
		* @param array $ar_fields
		* @return string $sql
		*/
		private static function build_sql_select(array $ar_fields) : string {

			$ar_safe_fields = array_map(function($field_name){
				return web_data::safe_field_name($field_name);
			}, $ar_fields);

			$sql = 'SELECT '.implode(',', $ar_safe_fields);

			return $sql;
		}//end build_sql_select



		/**
		* SAFE_FIELD_NAME
		* @return string $safe_name
		*/
		protected static function safe_field_name($field_name) {

			$safe_name = ($field_name==='*'
							|| strpos($field_name, 'DISTINCT')!==false
							|| strpos($field_name, 'CONCAT')!==false
							|| strpos($field_name, 'MATCH')!==false
							|| strpos($field_name, ' AS ')!==false
						)
						? $field_name
						: '`'.$field_name.'`';

			return $safe_name;
		}//end safe_field_name



		/**
		* BUILD_SQL_FROM
		* @return string $sql
		*/
		private static function build_sql_from($table) {

			$sql  = '';
			$sql .= 'FROM '.trim($table);

			return $sql;
		}//end build_sql_from



		/**
		* BUILD_SQL_WHERE
		* (!) Params are not typed on purpose: they come from the request as is (arrays, null...)
		* and must not raise a TypeError, as an empty value is simply ignored
		* @param string|null $lang
		* @param string|null $sql_filter
		* @param mixed $ignore_tags = true
		*	bool or boolean string ('false', '0'). If true, LIKE sentences on tagged text columns
		*	ignore tag contents when TAGGED_TEXT_FIELDS is defined. See mask_tags_sql_filter
		* @return string $sql
		*/
		private static function build_sql_where($lang, $sql_filter, $ignore_tags=true) : string {

			// ignore_tags. Normalize request values ('false', '0', 1...). Invalid values keep the default
			$ignore_tags = is_bool($ignore_tags)
				? $ignore_tags
				: ($ignore_tags===null ? true : (filter_var($ignore_tags, FILTER_VALIDATE_BOOLEAN, FILTER_NULL_ON_FAILURE) ?? true));

			// $sql  = '';
			// $sql .= 'WHERE section_id IS NOT NULL';

			// # SQL_FILTER
			// if(!empty($sql_filter) && strlen($sql_filter)>2 ) {
			// 	if($sql_filter===PUBLICATION_FILTER_SQL) {
			// 		$sql .= PHP_EOL . $sql_filter;
			// 	}else{
			// 		$sql .= PHP_EOL . 'AND ('.$sql_filter.')';
			// 	}
			// }

			// # LANG
			// if(!empty($lang)) {
			// 	if (strpos($lang, 'lg-')===false) {
			// 		$lang = 'lg-'.$lang;
			// 	}
			// 	$sql .= PHP_EOL . 'AND lang = \''.$lang.'\'';
			// }

			$ar_parts = [];

			// sql_filter
				if(!empty($sql_filter) && strlen($sql_filter)>2) {
					if($sql_filter===PUBLICATION_FILTER_SQL) {
						$ar_parts[] = $sql_filter;
					}else{
						$sql_filter_clean = ( substr($sql_filter, 0, 1)==='(' && substr($sql_filter, -1)===')' )
							? trim($sql_filter)
							: '('.trim($sql_filter).')';
						// Tagged text columns (transcriptions): LIKE operands are masked to
						// avoid false positives from tag payloads. See mask_tags_sql_filter
						// (!) Masked after the parentheses check: the rewrite wraps each LIKE in
						// parentheses and would skip the outer ones, detaching the lang condition
						if ($ignore_tags===true) {
							$sql_filter_clean = self::mask_tags_sql_filter($sql_filter_clean);
						}
						$ar_parts[] = $sql_filter_clean;
					}
				}

			// lang
				if(!empty($lang)) {

					$lang_code = (strpos($lang, 'lg-')===false)
						? 'lg-'.$lang
						: $lang;
					$ar_parts[] = '`lang`=\''.$lang_code.'\'';
				}

			// sql
				$sql = empty($ar_parts)
					? ''
					: 'WHERE ' . implode(' AND ', $ar_parts);


			return $sql;
		}//end build_sql_where



		/**
		* GET_TAGGED_TEXT_FIELDS
		* Columns whose stored text contains transcription tags. Defined by the publication
		* config constant TAGGED_TEXT_FIELDS. Opt-in: when it is not defined, no column is
		* masked and sql_filter is used as is (masking needs MariaDB >= 10.0.5 REGEXP_REPLACE
		* and it is slower on common terms, see mask_tags_sql_filter)
		* @return array
		*/
		private static function get_tagged_text_fields() : array {

			if (!defined('TAGGED_TEXT_FIELDS')) {
				return [];
			}

			// a comma separated string is accepted as well as an array
			$ar_fields = is_string(TAGGED_TEXT_FIELDS)
				? explode(',', TAGGED_TEXT_FIELDS)
				: (array)TAGGED_TEXT_FIELDS;

			// normalize. SQL column names are case insensitive
			return array_values(array_filter(array_map(function($field){
				return strtolower(trim((string)$field));
			}, $ar_fields)));
		}//end get_tagged_text_fields



		/**
		* GET_SQL_LITERAL_SPANS
		* Scan a SQL fragment and return the byte ranges [start, end) occupied by string
		* literals, so that rewrites can skip them.
		* Back quoted identifiers are consumed by the scanner (to keep it in sync when they
		* contain quotes) but not returned, as they are code and not data.
		* Doubled quotes ('') and backslash escapes are honored (default sql_mode).
		* @param string $sql
		* @return array|null Array of [start, end] ranges, or null if a quote is not closed
		*/
		private static function get_sql_literal_spans( string $sql ) : ?array {

			$ar_spans	= [];
			$len		= strlen($sql);
			$i			= 0;

			while ($i < $len) {

				$quote = $sql[$i];
				if ($quote!=="'" && $quote!=='"' && $quote!=='`') {
					$i++;
					continue;
				}

				$start	= $i;
				$closed	= false;
				$i++;
				while ($i < $len) {
					$current = $sql[$i];
					// backslash escape (not applicable to back quoted identifiers)
					if ($current==='\\' && $quote!=='`') {
						$i += 2;
						continue;
					}
					if ($current===$quote) {
						// doubled quote inside the literal ('' or "" or ``)
						if (($i+1) < $len && $sql[$i+1]===$quote) {
							$i += 2;
							continue;
						}
						$i++;
						$closed = true;
						break;
					}
					$i++;
				}

				if ($closed===false) {
					return null; // unbalanced quotes: caller must not rewrite
				}

				// back quoted identifiers are consumed, but are not literals
				if ($quote!=='`') {
					$ar_spans[] = [$start, $i];
				}
			}

			return $ar_spans;
		}//end get_sql_literal_spans



		/**
		* MASK_TAGS_SQL_FILTER
		* Rewrite LIKE / NOT LIKE operands of tagged text columns (transcriptions) so that
		* tag payloads are not searchable. Without this, a filter like "rsc36 LIKE '%1649%'"
		* matches values inside tags as [note-b-1-1-data:{'section_id':1649}:data],
		* returning false positives.
		* Tags are replaced by one space (not by an empty string) to avoid joining
		* the words around the tag, which would create new false positives.
		* Columns not in TAGGED_TEXT_FIELDS are left untouched, as are LIKE sentences
		* found inside string literals and sentences followed by COLLATE, ESCAPE or an
		* adjacent literal that the rewrite could not keep attached.
		* Opt-in (TAGGED_TEXT_FIELDS config). Requirements and costs:
		* - MariaDB >= 10.0.5 (REGEXP_REPLACE). MySQL 5.x has no REGEXP_REPLACE and the
		*   MySQL 8 ICU engine rejects the '[[]' class of the tags pattern: the query fails
		* - REGEXP_REPLACE runs on every row matching the raw LIKE: common terms over big
		*   transcriptions are much slower (measured '%casa%' 1.4 s -> 12.8 s on mdcat)
		*
		* Ex. "rsc36 LIKE '%1649%'" is converted to
		*	  "(REGEXP_REPLACE(rsc36, '<tags>', ' ') LIKE '%1649%')"
		*
		* @param string $sql_filter
		* @return string
		*/
		private static function mask_tags_sql_filter( string $sql_filter ) : string {

			$ar_fields = self::get_tagged_text_fields();
			if (empty($ar_fields)) {
				return $sql_filter;
			}

			// literal ranges. LIKE sentences inside them are data, not SQL
			$ar_spans = self::get_sql_literal_spans($sql_filter);
			if ($ar_spans===null) {
				debug_log(__METHOD__." Unbalanced quotes in sql_filter. Tags masking skipped: ".$sql_filter, logger::ERROR);
				return $sql_filter;
			}

			// Blank the contents of every literal, keeping its quotes and its length, and
			// search on this copy. This way a LIKE sentence written inside a literal is not
			// matched, and it can not swallow the real sentences that follow it either.
			// Offsets are preserved, so matches are sliced from the original filter
			$scan = $sql_filter;
			foreach ($ar_spans as $span) {
				$inner_len = $span[1] - $span[0] - 2;
				if ($inner_len>0) {
					$scan = substr_replace($scan, str_repeat(' ', $inner_len), $span[0]+1, $inner_len);
				}
			}

			// column (optionally back quoted, up to two qualifier levels) + [NOT] LIKE
			// + string literal + optional ESCAPE clause. Both quote styles are accepted,
			// as MySQL takes "..." as a string literal too (default sql_mode).
			// Not rewritten when followed by COLLATE (it would apply to the wrapping
			// parentheses, changing the comparison collation), by an ESCAPE clause not
			// captured here or by an adjacent literal ('a' 'b' concatenation)
			$literal = '(?:\'(?:[^\'\\\\]|\\\\.|\'\')*\'|"(?:[^"\\\\]|\\\\.|"")*")';
			$pattern = '/((?:`?\w+`?\.){0,2}`?(\w+)`?)\s+(NOT\s+)?LIKE\s+('. $literal .')(\s+ESCAPE\s+'. $literal .')?(?!\s*(?:COLLATE\b|ESCAPE\b|[\'"]))/i';

			$found = preg_match_all($pattern, $scan, $matches, PREG_OFFSET_CAPTURE|PREG_SET_ORDER);
			if ($found===false) {
				debug_log(__METHOD__." preg_match_all failed (".preg_last_error_msg()."). Tags masking skipped", logger::ERROR);
				return $sql_filter;
			}

			$tags_pattern = tags_mask::get_tags_sql_pattern();

			// replace backwards to keep offsets valid
			$ar_matches = array_reverse($matches);
			foreach ($ar_matches as $match) {

				$offset	= $match[0][1];
				$name	= strtolower(trim($match[2][0], '`'));
				$not	= !empty($match[3][0]);

				// only tagged text columns are masked (column names are case insensitive)
				if (!in_array($name, $ar_fields, true)) {
					continue;
				}

				// values are sliced from the original filter, as the searched copy is blanked
				$whole	= substr($sql_filter, $offset, strlen($match[0][0]));
				$column	= substr($sql_filter, $match[1][1], strlen($match[1][0]));
				$value	= substr($sql_filter, $match[4][1], strlen($match[4][0]));
				$escape	= isset($match[5]) && $match[5][1]!==-1
					? substr($sql_filter, $match[5][1], strlen($match[5][0]))
					: '';

				$masked_column	= 'REGEXP_REPLACE('. $column .", '". $tags_pattern ."', ' ')";
				$operator		= $not===true ? ' NOT LIKE ' : ' LIKE ';

				// Cheap pre-filter. The masked text is the raw one with every tag replaced by
				// a single space, so a searched value without spaces (nor '_', that could match
				// that very space) can only match the masked text if it is present in the raw
				// column too. When that holds, the raw LIKE is added as first condition and
				// REGEXP_REPLACE is evaluated only on the rows that already matched, which is
				// much cheaper on big transcriptions.
				// Values with spaces can span a tag ('palabra[index-n-1]junta' matches
				// '%palabra junta%'), and NOT LIKE inverts the sentence, so both are excluded
				$can_prefilter = $not===false
					&& $escape===''
					&& strpbrk(substr($value, 1, -1), " \t\r\n_")===false;

				$replacement = $can_prefilter===true
					? '('. $column .' LIKE '. $value .' AND '. $masked_column .' LIKE '. $value .')'
					: '('. $masked_column . $operator . $value . $escape .')';

				$sql_filter = substr_replace($sql_filter, $replacement, $offset, strlen($whole));
			}

			return $sql_filter;
		}//end mask_tags_sql_filter



		/**
		* BUILD_SQL_GROUP
		* @return string $sql
		*/
		private static function build_sql_group($group) {

			# Prevent duplications
			$group = str_ireplace('GROUP BY', '', $group);

			$sql  = '';
			$sql .= 'GROUP BY '.$group;

			return $sql;
		}//end build_sql_group



		/**
		* BUILD_SQL_ORDER
		* @return string $sql
		*/
		private static function build_sql_order($order) {

			# Prevent duplications
			$order = str_ireplace('ORDER BY', '', $order);

			$sql  = '';
			$sql .= 'ORDER BY '.$order;

			return $sql;
		}//end build_sql_order



		/**
		* BUILD_SQL_LIMIT
		* @return string $sql
		*/
		private static function build_sql_limit($limit, $offset=null) {

			$sql  = '';
			$sql .= 'LIMIT '.intval($limit);
			# OFFSET
			if(!empty($offset)) {
				$sql .= ' OFFSET '.intval($offset);
			}

			return $sql;
		}//end build_sql_limit



		/**
		* GET_PUBLICATION_SCHEMA
		* @return object|false $data
		*/
		public static function get_publication_schema( $table=null ) {

			$data = false;

			$all_tables = self::get_all_tables();
			if (!in_array('publication_schema', $all_tables)) {
				return 'table with publication_schema is not set';
			}

			$strQuery = 'SELECT data FROM publication_schema WHERE id = 1';

			$dbh	= web_data::get_PDO_connection();
			$stmt	= $dbh->prepare($strQuery);
			$stmt->setFetchMode(PDO::FETCH_ASSOC);
			$result = $stmt->execute();

			if($result) while ($row = $stmt->fetch()) {
				$data = !empty($row['data'])
					? json_decode($row['data'])
					: null;
				break;
			}

			return $data;
		}//end get_publication_schema



		/**
		* PORTAL_RESOLVE
		* @return array $ar_portal
		*/
		private static function portal_resolve($rows, $current_field, $options, $resolve_portals_custom, bool $resolve_dd_relations) {
			$ar_portal=array();

			// resolve cases
			switch (true) {
				case ($resolve_dd_relations===true):
					// resolve_dd_relations is received
					$current_field_ar_id	= 'dd_relations'; // column name 'dd_relations' expected
					$table					= ''; // will be resolved later
					// publication_schema
					$publication_schema	= self::get_publication_schema(); // Like: {"image": "image","dd_relations":{"rsc170":"images"}
					$dd_relations		= isset($publication_schema->dd_relations)
						? $publication_schema->dd_relations
						: null;
					break;

				case ($resolve_portals_custom!==false && !empty($resolve_portals_custom->{$current_field})):
					// resolve_portals_custom is received (null-valued entries fall to default case)
					$current_field_ar_id	= $current_field;	//in_array($current_field, (array)$resolve_portals_custom);
					$table					= $resolve_portals_custom->{$current_field};
					break;

				default:
					// default case
					$current_field_ar_id	= str_replace('_table', '_id', $current_field); // los datos apuntan al nombre de esta columna (XX_table) pero están en XX_id
					$table					= $rows[$current_field];
					break;
			}

			// table with additional column name when match values, like 'hoard.term_id'
				$match_column = 'section_id';  // default
				if (strpos($table, '.')!==false) {
					$ar_bits		= explode('.', $table);
					$table			= $ar_bits[0]; // overwrite table var name (!)
					$match_column	= $ar_bits[1]; // overwrite var match_column (!)
				}

			$current_ar_value = !empty($rows[$current_field_ar_id])
				? json_decode($rows[$current_field_ar_id])
				: null;

			// link case {"link","auto"}
				if ($current_field==='link' && $resolve_portals_custom->{$current_field}==='auto') {
					if (!empty($rows[$current_field_ar_id])) {
						$parsed_value = json_decode($rows[$current_field_ar_id]);
						if (isset($parsed_value->section_id)) {
							$table				= $parsed_value->table;
							$current_ar_value	= [$parsed_value->section_id];
						}
					}
				}

			if(is_array($current_ar_value)) foreach ($current_ar_value as $p_value) {

				// dd_relations case
					if (isset($dd_relations) && isset($p_value->section_tipo)) {
						// table map
						if (isset($dd_relations->{$p_value->section_tipo})) {
							$table = $dd_relations->{$p_value->section_tipo};
						}else{
							// skip unable to resolve values
							debug_log(__METHOD__." Skipped locator. Unable to resolve value from ".to_string($p_value), logger::ERROR);
							continue;
						}
					}

				// parse value on locator case
					if (is_object($p_value)) {
						$p_value = $p_value->section_id ?? null;
					}

				// skip empty values
					if (empty($p_value)) {
						continue;
					}


		 		$portal_options = new stdClass();
		 			$portal_options->table = $table;
		 			$portal_options->lang  = $options->lang;
		 			if (isset($options->resolve_portal)) {
		 			$portal_options->resolve_portal = $options->resolve_portal;
		 			}

		 			# Resolve_portals_custom deeper
		 			# If you need deep resolve, define resolve_portals_custom using table name separated by point like:
		 			# [
					#	'eventos' 	 		 => 'eventos',
					#	'eventos.documentos' => 'image'
					# ]
		 			if ($resolve_portals_custom!==false) {
		 				# Defined resolve_portals_custom for this table
	 					$portal_options->resolve_portals_custom = new stdClass();
	 					# (!) Note that $resolve_portals_custom is different that $options->resolve_portals_custom because is already parsed
		 				foreach ($resolve_portals_custom as $name => $target) {
		 					$field_bits = explode('.', $name);
		 					if (isset($field_bits[1])) {
		 						$portal_options->resolve_portals_custom->{$field_bits[1]} = $target;
		 					}
		 				}
		 				// dump($portal_options->resolve_portals_custom, ' portal_options->resolve_portals_custom ++ ---------------------------- '.to_string($table));
	 				}

		 			$filter = PUBLICATION_FILTER_SQL;
		 			if( !empty($options->portal_filter)
		 				&& isset($options->portal_filter[$portal_options->table]) )
		 				{
		 					$filter = $options->portal_filter[$portal_options->table];
		 			}

		 			// format value for sql filter (add quotes or not)
		 			$p_value_filter = $match_column==='section_id'
		 				? $p_value // treated as int
		 				: '\'' . $p_value . '\''; // treated as string

					$portal_options->sql_filter	= '`' . $match_column . '`' . ' = ' . $p_value_filter . (!empty($filter) ? $filter : '');
					$portal_options->order		= false;
					$portal_options->caller		= 'portal_resolve';


		 		$rows_data = (array)self::get_rows_data($portal_options)->result;
		 		//error_log( 'rows_data: '. to_string($portal_options) );

		 		if (!empty($rows_data[0])) {

		 			$ar_portal[] = $rows_data[0];

		 			# MAP
					# Format : [{"field":birthplace_id","function":"resolve_geolocation","output_field":"birthplace_obj"}]
					if (property_exists($options, "map") && $options->map!==false) {
						# Exec defined map functions and add columns as request
						foreach ($ar_portal as $key => $row) {
							foreach ($options->map as $map_obj) {
								if ($map_obj->table===$table) {
									$ar_portal[$key][$map_obj->output_field] = map::{$map_obj->function}($row[$map_obj->field], $options->lang);
								}
							}
						}
					}
		 		}
		 		#dump($ar_portal, " ar_portal ".to_string());
		 	}

		 	return (array)$ar_portal;
		}//end portal_resolve



		/**
		* COUNT_RECORDS
		* @return int $total
		*/
		private static function count_records($sql, $db_name) {

			$ar_lines = explode(PHP_EOL, $sql);
			$ar_clean = [];
			foreach ($ar_lines as $key => $line) {
				switch (true) {
					case (strpos($line, 'GROUP BY')!==false):
						// add edited line
						# alias case (like  floor(YEAR(fecha_inicio)/10)*10 as decade)
						if (strpos($line, ' AS ')!==false) {
							$ar_parts = explode(' AS ', $line);
							// $ar_lines[$key] = $ar_parts[0];
							$ar_clean[] = $ar_parts[0];
						}
						break;
					case (strpos($line, 'LIMIT')!==false):
					case (strpos($line, 'OFFSET')!==false):
					case (strpos($line, 'ORDER BY')!==false):
						// ignore line
						// $ar_lines[$key] = '';
						break;
					default:
						// add untouched line
						$ar_clean[] = $line;
						break;
				}
			}
			// $count_query = trim(implode("\n", $ar_lines));  //."\n) AS tables";
			$count_query = trim(implode(PHP_EOL, $ar_clean));
			$count_query = 'SELECT COUNT(*) AS total FROM (' .PHP_EOL. $count_query .PHP_EOL. ') AS tcount;';

			debug_log(__METHOD__.' count_query - ' .PHP_EOL. to_string($count_query), logger::ERROR);

			// prepare PDO
				try {
					$dbh = web_data::get_PDO_connection(
						MYSQL_DEDALO_HOSTNAME_CONN,
						MYSQL_DEDALO_USERNAME_CONN,
						MYSQL_DEDALO_PASSWORD_CONN,
						$db_name
					);
					$stmt	= $dbh->prepare($count_query);
					$stmt->setFetchMode(PDO::FETCH_ASSOC);
					$result = $stmt->execute();

					$dbh = null;
				} catch (PDOException $e) {
					// print "Error!: " . $e->getMessage() . "<br/>";
					error_log(__METHOD__ ." ".PHP_EOL." ". $e->getMessage() );
					die();
				}

			if (!isset($result) || !$result) {
				if(SHOW_DEBUG) {
					#dump($count_query, "<H2>DEBUG Error Processing Request</H2> " .$conn->error );
					$current_error = isset($dbh) && isset($dbh->error)
						? $dbh->error
						: 'Unknown error';
					debug_log(__METHOD__
						." DEBUG Error Processing Request : $count_query - ". $current_error
						, logger::ERROR
					);
					#trigger_error("Error Processing Request");
					#echo "<div class=\"error\" >Error Processing Request</div>";
					#throw new Exception("Error Processing Request", 1);
				}
				# Si hay problemas en la búsqueda, no lanzaremos error ya que esta función se usa en partes públicas
				return 0;
			}
			$row	= $stmt->fetch();
			$total	= $row['total'];

			return (int)$total;
		}//end count_records



		/**
		* GET_DATA
		* Exec a remote connection and get remote data with options as JSON
		* @return object $rows_data
		*//* UNUSED NOW !!
		public static function get_data($request_options) {

			$start_time = microtime(1);

			$WORKING_MODE = WORKING_MODE;	//'remote';

			if ($WORKING_MODE==='remote') {
				# FROM JSON URL IN SERVER SIDE

				$url = JSON_TRIGGER_URL . '?options=' . urlencode( json_encode($request_options) );
					#dump($url, ' url ++ '.to_string());
				$dedalo_data_file 	= file_get_contents($url) ;
					#dump($dedalo_data_file, ' $dedalo_data_file ++ '.to_string($url));
				$dedalo_data = json_decode( $dedalo_data_file, false, 512, JSON_UNESCAPED_UNICODE );
					#dump($dedalo_data, ' dedalo_data ++ '.to_string($url)); #die();

			}else{
				# FROM CURRENT SERVER

				$dedalo_get = isset($request_options->dedalo_get) ? $request_options->dedalo_get : null;
				switch ($dedalo_get) {

					case 'tables_info':
						#
						# Execute data retrieving
						$full = isset($request_options->full) ? $request_options->full : false;
						$dedalo_data = (object)web_data::get_tables_info( $full );
						break;

					case 'publication_schema':
						#
						# Execute data retrieving
						$dedalo_data = (object)web_data::get_full_publication_schema();
						break;

					case 'records':
					default:
						#
						# Execute data retrieving
						$dedalo_data = (object)web_data::get_rows_data( $request_options );
						break;
				}
			}

			if (!is_object($dedalo_data)) {
				$dedalo_data = new stdClass();
					$dedalo_data->result = array();
					if(SHOW_DEBUG===true) {
						$dedalo_data->debug = new stdClass();
						$dedalo_data->debug->info = "Error in response results: ".to_string($dedalo_data_file);
					}
			}
			#error_log( to_string($dedalo_data->debug) );

			$dedalo_data->debug = isset($dedalo_data->debug) && is_object($dedalo_data->debug) ? $dedalo_data->debug : new stdClass();
			$dedalo_data->debug->total_time = round(microtime(1)-$start_time,3);

			return (object)$dedalo_data;
		}//end get_data
		*/



		/**
		* GET_ALL_TABLES
		* @return array $ar_tables
		*/
		private static function get_all_tables() {

			$strQuery = "SHOW TABLES";

			$dbh	= web_data::get_PDO_connection();
			$stmt	= $dbh->prepare($strQuery);
			$stmt->setFetchMode(PDO::FETCH_ASSOC);
			$result = $stmt->execute();

			$ar_tables = array();
			while ($row = $stmt->fetch()) {
				$ar_tables[] = reset($row);
			}

			return $ar_tables;
		}//end get_all_tables



		/**
		* GET_TABLE_FIELDS
		* @return array $ar_columns
		*/
		private static function get_table_fields( $table, $full=false ) {

			if(!self::check_safe_value('table', $table)) {
				die("Error. Illegal table: ".$table);
			}

			$strQuery = "SHOW COLUMNS FROM `" . str_replace("`", "``", $table) . "`";

			$dbh	= web_data::get_PDO_connection();
			$stmt	= $dbh->prepare($strQuery);
			$stmt->setFetchMode(PDO::FETCH_ASSOC);
			$result = $stmt->execute();

			$ar_columns = array();
			while ($row = $stmt->fetch()) {

				if ($row['Field']==='id') {
					continue;	// Skip id field always
				}

				$ar_columns[] = ($full)
					? $row
					: $row['Field'];
			}

			return (array)$ar_columns;
		}//end get_table_fields



		/**
		* GET_TABLES_INFO
		* @return
		*/
		public static function get_tables_info( $full=false ) {

			$tables_info = new stdClass();

			$ar_tables = self::get_all_tables();
			foreach ($ar_tables as $table) {

				$table_fields = self::get_table_fields( $table, $full);

				$tables_info->{$table} = $table_fields;
			}

			return (object)$tables_info;
		}//end get_tables_info



		/**
		* GET_TABLES_INFO_REMOTE
		* @return
		*/
			// private static function get_tables_info_remote() {

			// 	# Defined in config
			// 	$trigger_url = JSON_TRIGGER_URL;

			// 	#
			// 	# FROM JSON URL IN SERVER SIDE
			// 	$url = $trigger_url . '?options=' . urlencode( json_encode($request_options) );
			// 		#dump($url, ' url ++ '.to_string());
			// 	$search_data_records_file 	= file_get_contents($url) ;
			// 		#dump($search_data_records_file, ' $search_data_records_file ++ '.to_string());
			// 	$search_data_records 		= json_decode( $search_data_records_file, false, 512, JSON_UNESCAPED_UNICODE );
			// 		#dump($search_data_records, ' search_data_records ++ '.to_string()); die();
			// }//end get_tables_info_remote



		/**
		* GET_POSTERFRAME_FROM_VIDEO
		* @return string
		*/
		protected static function get_posterframe_from_video( $video_url ) {
			return str_replace(array('/'.DEDALO_AV_QUALITY_DEFAULT.'/','.mp4'), array('/posterframe/','.jpg'), $video_url);
		}//end get_posterframe_from_video



		/**
		* POSTPROCESS_FIELD
		* Aply process to field data
		* Example: Remove tags from video transcription raw text
		* @return mixed $data
		*/
		private static function postprocess_field($field_name, $data) {

			switch ($field_name) {
				case 'rsc36': // Transcription text
					$data = TR::deleteMarks($data);
					break;

				default:
					# Nothing to do here
					break;
			}

			return $data;
		}//end postprocess_field



	/**
	* GET_REEL_TERMS
	* Resuelve TODOS los términos utilizados en la transcripción de la cinta/s dada/s
	* @param object $request_options
	* 	string $request_options->av_section_id (one or various numbers separated by comma)
	* 	string $request_options->lang like 'lg-spa' (optional)
	* @return
	*/
	public static function get_reel_terms( $request_options ) {
		#dump($request_options, ' $request_options ++ '.to_string());

		$options = new stdClass();
			$options->av_section_id = null;
			$options->lang 			= WEB_CURRENT_LANG_CODE;
			foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

		// check vars
			if(!empty($options->lang) && !self::check_safe_value('lang', $options->lang)) {
				die("Error. Illegal lang: ".$options->lang);
			}
			if(!empty($options->av_section_id) && !self::check_safe_value('section_id', $options->av_section_id)) {
				die("Error. Illegal av_section_id: ".$options->av_section_id);
			}

		$ar_restricted_terms = defined('AR_RESTRICTED_TERMS') && !empty(AR_RESTRICTED_TERMS)
			? json_decode(AR_RESTRICTED_TERMS)
			: [];

		$TRANSCRIPTION_TIPO			= TRANSCRIPTION_TIPO;
		$AUDIOVISUAL_SECTION_TIPO	= AUDIOVISUAL_SECTION_TIPO;
		$field_indexation			= defined('FIELD_INDEX') ? FIELD_INDEX : 'indexation';

		$ar_filter = array();
		$ar = explode(',', $options->av_section_id);
		foreach ($ar as $current_av_section_id) {
			$current_av_section_id = trim($current_av_section_id);
			$ar_filter[] = "`{$field_indexation}` LIKE '%\"section_id\":\"$current_av_section_id\",\"section_tipo\":\"$AUDIOVISUAL_SECTION_TIPO\",\"component_tipo\":\"$TRANSCRIPTION_TIPO\"%'";
			#$ar_filter[] = "MATCH (`indexation`) AGAINST ('\"section_id\":\"$current_av_section_id\",\"section_tipo\":\"$AUDIOVISUAL_SECTION_TIPO\",\"component_tipo\":\"$TRANSCRIPTION_TIPO\"')";
		}
		$sql_filter = '('.implode(' OR ', $ar_filter).')';


		$response = new stdClass();
			$response->result 	= false;
			#$response->msg 	= 'Error. Request failed (get_reel_terms)';

		// Format: "section_top_id":"30","section_tipo":"rsc167","section_id":"39"

		$s_options = new stdClass();
			$s_options->table 		= (string)TABLE_THESAURUS;
			$s_options->ar_fields 	= array(FIELD_TERM_ID,FIELD_TERM,$field_indexation);
			$s_options->lang 		= $options->lang;
			$s_options->order 		= FIELD_TERM ." ASC";
			#$s_options->sql_filter = (string)"`index` LIKE '%\"section_id\":\"$av_section_id\",\"component_tipo\":\"$TRANSCRIPTION_TIPO\"%'" . PUBLICATION_FILTER_SQL;
			$s_options->sql_filter 	= (string)$sql_filter;

		$rows_data	= (object)web_data::get_rows_data( $s_options );
			#dump($rows_data, ' rows_data ++ '.to_string());

		$ar_termns = array();
		if (is_array($rows_data->result)) foreach($rows_data->result as $key => $value) {

			$term_id  	= $value[FIELD_TERM_ID];
			$indexation = !empty($value[$field_indexation])
				? json_decode($value[$field_indexation])
				: [];

			# Skip optional restricted terms (defined in config)
			if (in_array($term_id, $ar_restricted_terms)) {
				continue;
			}

			# Skip already included (duplicates)
			if (isset($ar_termns[$term_id])) {
				continue;
			}

			# Calculate locators
			$current_locators = array();
			foreach ((array)$indexation as $c_locator) {
				if ($c_locator->section_tipo===$AUDIOVISUAL_SECTION_TIPO && in_array($c_locator->section_id, $ar)) {
					$current_locators[] = $c_locator;
				}
			}

			$term_data = new stdClass();
				$term_data->term_id  = $term_id;
				$term_data->term 	 = $value[FIELD_TERM];
				$term_data->locators = $current_locators;
			$ar_termns[] = $term_data;
		}
		#dump($ar_termns, ' $ar_termns ++ '.to_string());

		$response->result = $ar_termns;
		#$response->msg 	  = 'Request done successfully';


		return (object)$response;
	}//end get_reel_terms



	/**
	* GET_REEL_FRAGMENTS_OF_TYPE
	* Return all fragments inside reel transcription (of passed type like 'index')
	* @param string $av_section_id (one or various separated by comma)
	* @return
	*/
	public static function get_reel_fragments_of_type( $request_options ) {

		$response = new stdClass();
			$response->result 	= false;
			$response->msg 		= 'Error. Request failed. '.__METHOD__;

		$options = new stdClass();
			$options->av_section_id 	= null;
			$options->type 				= 'indexIn'; // Deafult is indexIn
			$options->lang 				= WEB_CURRENT_LANG_CODE;
			$options->return_text		= false;
			$options->filter_by_tag_id	= false; // false | array
			$options->return_restricted	= false;
			foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

		// check vars
			if(!empty($options->lang) && !self::check_safe_value('lang', $options->lang)) {
				die("Error. Illegal lang: ".$options->lang);
			}
			if(!empty($options->av_section_id) && !self::check_safe_value('section_id', $options->av_section_id)) {
				die("Error. Illegal av_section_id: ".$options->av_section_id);
			}

		#
		# Transcription text
		$TRANSCRIPTION_TIPO 		= TRANSCRIPTION_TIPO;
		$AUDIOVISUAL_SECTION_TIPO 	= AUDIOVISUAL_SECTION_TIPO;

		$sql_filter = '(section_id = '.(int)$options->av_section_id.')';

		$s_options = new stdClass();
			$s_options->table 		= (string)TABLE_AUDIOVISUAL;
			$s_options->ar_fields 	= array(TRANSCRIPTION_TIPO,FIELD_VIDEO);
			$s_options->lang 		= (string)$options->lang;
			$s_options->sql_filter 	= (string)$sql_filter;

		$rows_data	= (object)web_data::get_rows_data( $s_options );
			#dump($rows_data, ' rows_data ++ '.to_string()); #die();

		$raw_text = '';
		if (is_array($rows_data->result)) foreach($rows_data->result as $key => $value) {
			$raw_text = $value[TRANSCRIPTION_TIPO];
			break;
		}

		#
		# Find indexations etc.
		$pattern 	= TR::get_mark_pattern($options->type);
		preg_match_all($pattern, $raw_text, $matches);
			#dump($matches, ' matches ++ '.to_string());
		$key_tag 	= 1;
		$key_tag_id = 4;

		$ar_tag_id = $matches[$key_tag_id];

		$ar_fragments = [];
		$fr_options = new stdClass();
			$fr_options->lang   		 		= $options->lang;
			$fr_options->raw_text 		 		= $raw_text;
			$fr_options->av_section_id  		= $options->av_section_id;
			$fr_options->component_tipo 	 	= TRANSCRIPTION_TIPO;
			$fr_options->section_tipo 	 	 	= AUDIOVISUAL_SECTION_TIPO;
			$fr_options->video_url 	 	 		= null; # Like 'http://mydomain.org/dedalo/media/av/404/'
			$fr_options->margin_seconds_in  	= null;
			$fr_options->margin_seconds_out 	= null;
			$fr_options->fragment_terms_inside 	= false; # If true, calculate terms indexed inside this fragment
			$fr_options->indexation_terms 		= false; # If true, calculate all terms used in this indexation

		foreach ($ar_tag_id as $tag_id) {

			// filter_by_tag_id
				if ($options->filter_by_tag_id!==false) {
					if (!in_array($tag_id, $options->filter_by_tag_id)) {
						continue; // Skip
					}
				}

			# Set tag_id
			$fr_options->tag_id = $tag_id;

			$fragment = web_data::build_fragment($fr_options);
				#dump($fragment, ' fragment ++ '.to_string($fr_options));

			$element = new stdClass();
				$element->tag_id  	 	= $tag_id;
				$element->tcin_secs  	= $fragment->tcin_secs;
				$element->tcout_secs 	= $fragment->tcout_secs;
				$element->video_url  	= $fragment->video_url;
				$element->subtitles_url = $fragment->subtitles_url;

				if ($options->return_text===true) {
					//$element->fragm = $fragment->fragm;

					// Remove restricted_text from raw text
					$clean_fragm 		  = web_data::remove_restricted_text( $fragment->fragm, $options->av_section_id );
					// Finally remove all tags (deleteMarks is the last process before send the text)
					$clean_fragm 		  = TR::deleteMarks($clean_fragm);

					$element->fragm 	  = $clean_fragm;
				}

			$ar_fragments[] = $element;
		}//end foreach ($ar_tag_id as $tag_id)


		// response
			$response->result 	= $ar_fragments;
			$response->msg 		= 'Ok. Request done. '.__METHOD__;


		// restricted fragments. optional
			if ($options->return_restricted===true) {
				$ar_restricted_fragments = web_data::get_ar_restricted_fragments( $options->av_section_id );
					#dump($ar_restricted_fragments, ' ar_restricted_fragments ++ '.to_string($options->av_section_id));
				$response->ar_restricted_fragments = $ar_restricted_fragments;
			}


		return (object)$response;
	}//end get_reel_fragments_of_type



	/**
	* GET_FRAGMENT_FROM_INDEX_LOCATOR
	* 	Calculate all fragments indexed with this locator
	* @param object $options
	* $index_loc
	*	$index_locator can be a PHP object or a JSON string representation of the object
	* @return object $response
	*/
	public static function get_fragment_from_index_locator( $options ) {

		// options
			$index_locator	= $options->index_locator ?? null;
			$lang			= $options->lang ?? WEB_CURRENT_LANG_CODE;
			$fragment_terms	= $options->fragment_terms ?? false;

		// response
			$response = new stdClass();
				$response->result	= false;
				$response->msg		= 'Error. Request failed (get_fragment_from_index_locator)';

		// check vars
			if(!empty($options->lang) && !self::check_safe_value('lang', $options->lang)) {
				trigger_error("Error. Illegal lang: ".$options->lang);
				$response->msg = 'Error. Invalid lang: '.$options->lang.')';
				return $response;
			}

		// locator
			// Sample:
			// {"type":"dd96","tag_id":"1","section_id":"1","section_tipo":"rsc167","component_tipo":"rsc36","section_top_id":"1","section_top_tipo":"oh1","from_component_tipo":"hierarchy40"}
			if (is_array($index_locator)) {
				$index_locator = reset($index_locator);
			}
			if (is_object($index_locator)) {
				$locator = $index_locator;
			}else{
				$locator = json_decode($index_locator);
				if (is_array($locator)) {
					$locator = reset($locator);
				}
			}

		// short vars
			$av_section_id	= $locator->section_id;
			$tag_id			= $locator->tag_id ?? null;

		// audiovisual data. Raw text
			$s_options = new stdClass();
				$s_options->table				= TABLE_AUDIOVISUAL;
				$s_options->ar_fields			= array(FIELD_VIDEO, FIELD_TRANSCRIPTION);
				$s_options->lang				= $lang;
				$s_options->sql_filter			= '`section_id` = '.(int)$av_section_id;
				$s_options->apply_postprocess	= false; // Avoid clean text on false

			$rows_data = (object)web_data::get_rows_data( $s_options );
			if (empty($rows_data->result)) {
				// return null;
				$response->result	= null;
				$response->msg		= 'Error. Empty audiovisual records. Not found section_id: '.$av_section_id.')';
				return $response;
			}

		// fragment data. Create fragment and thesaurus associated
			$raw_text	= reset($rows_data->result)[FIELD_TRANSCRIPTION];
			$video_url	= reset($rows_data->result)[FIELD_VIDEO];

			$f_options = new stdClass();
				$f_options->tag_id					= $tag_id;
				$f_options->av_section_id			= $av_section_id;
				$f_options->lang					= $lang;
				$f_options->component_tipo			= AV_TIPO;
				$f_options->section_tipo			= $locator->section_tipo;
				$f_options->raw_text				= $raw_text;
				$f_options->fragment_terms_inside	= $fragment_terms; // bool
				$f_options->indexation_terms		= $fragment_terms; // bool

			$fragments_obj = web_data::build_fragment( $f_options );

		// remove_restricted_text in fragment
			if (isset($fragments_obj->fragm)) {
				// Remove restricted_text from raw text
				$clean_fragm = web_data::remove_restricted_text( $fragments_obj->fragm, $av_section_id );
				// Finally remove all tags (deleteMarks is the last process before send the text)
				$clean_fragm = TR::deleteMarks($clean_fragm);
				$fragments_obj->fragm = $clean_fragm;
			}

		// add self $index_locator to fragments_obj
			if (!empty($fragments_obj)) {
				$fragments_obj->index_locator = $index_locator;
			}

		// response ok
			$response->result	= $fragments_obj;
			$response->msg		= 'Request done successfully';


		return $response;
	}//end get_fragment_from_index_locator



	/**
	* GET_INDEXATION_TERMS
	* Calculate all terms used in current indexation
	* @return object $rows_data
	*/
	public static function get_indexation_terms( $tag_id, $av_section_id, $lang ) {
		/*
			$AUDIOVISUAL_SECTION_TIPO 	= AUDIOVISUAL_SECTION_TIPO;

			$options = new stdClass();
				$options->table 		= (string)TABLE_THESAURUS;
				$options->ar_fields 	= array('term_id',FIELD_TERM);
				$options->lang 			= $lang;
				$options->order 		= null;
				#$options->sql_filter 	= (string)"`index` LIKE '%\"section_id\":\"$av_section_id\",\"component_tipo\":\"$TRANSCRIPTION_TIPO\",\"tag_id\":\"$tag_id\"%'" . PUBLICATION_FILTER_SQL;
				// "type":"dd96","tag_id":"1","section_id":"22","section_tipo":"rsc167","component_tipo":"rsc36","section_top_id":"17","section_top_tipo":"oh1","from_component_tipo":"hierarchy40"
				# {"type":"dd96","tag_id":"10","section_id":"9","section_tipo":"rsc167","component_tipo":"rsc36","section_top_id":"9","section_top_tipo":"oh1","from_component_tipo":"hierarchy40"}
				$options->sql_filter 	= (string)"`indexation` LIKE '%\"type\":\"dd96\",\"tag_id\":\"$tag_id\",\"section_id\":\"$av_section_id\",\"section_tipo\":\"$AUDIOVISUAL_SECTION_TIPO\"%'" . PUBLICATION_FILTER_SQL;

			$rows_data	= (object)web_data::get_rows_data( $options );
				#dump($rows_data, ' rows_data ++ '.to_string($tag_id));

			$AR_RESTRICTED_TERMS = json_decode(AR_RESTRICTED_TERMS);
			foreach ($rows_data->result as $key => $value) {
				# Remove restricted terms
				if (in_array($value['term_id'], $AR_RESTRICTED_TERMS)) {
					unset($rows_data->result[$key]);
				}
			}
			# Reset array keys
			$rows_data->result = array_values($rows_data->result);
			*/

		# Unified version
		// $locator = new locator();
		// 	$locator->set_tag_id($tag_id);
		// 	$locator->set_section_id($av_section_id);
		// 	$locator->set_section_tipo(AUDIOVISUAL_SECTION_TIPO);
		$locator = (object)[
			'tag_id'		=> $tag_id,
			'section_id'	=> $av_section_id,
			'section_tipo'	=> AUDIOVISUAL_SECTION_TIPO
		];

		$rows_data = web_data::get_indexation_terms_multiple( array($locator), $lang );

		return $rows_data;
	}//end get_indexation_terms



	/**
	* GET_INDEXATION_TERMS_multiple
	* Calculate all terms used in current indexations
	* @return object $rows_data
	*/
	public static function get_indexation_terms_multiple( array $locators, string $lang=WEB_CURRENT_LANG_CODE ) : object {

		$AUDIOVISUAL_SECTION_TIPO = AUDIOVISUAL_SECTION_TIPO;

		$field_indexation = defined('FIELD_INDEX') ? FIELD_INDEX : 'indexation';

		$options = new stdClass();
			$options->table		= (string)TABLE_THESAURUS;
			$options->ar_fields	= array('term_id',FIELD_TERM);
			$options->lang		= $lang;
			$options->order		= null;
			#$options->sql_filter 	= (string)"`index` LIKE '%\"section_id\":\"$av_section_id\",\"component_tipo\":\"$TRANSCRIPTION_TIPO\",\"tag_id\":\"$tag_id\"%'" . PUBLICATION_FILTER_SQL;
			// "type":"dd96","tag_id":"1","section_id":"22","section_tipo":"rsc167","component_tipo":"rsc36","section_top_id":"17","section_top_tipo":"oh1","from_component_tipo":"hierarchy40"
			# {"type":"dd96","tag_id":"10","section_id":"9","section_tipo":"rsc167","component_tipo":"rsc36","section_top_id":"9","section_top_tipo":"oh1","from_component_tipo":"hierarchy40"}

			$ar_filter = array();
			foreach ((array)$locators as $key => $locator) {

				$tag_id				= $locator->tag_id;
				$av_section_id		= $locator->section_id;
				$av_section_tipo	= $locator->section_tipo;

				$ar_filter[] = "`{$field_indexation}` LIKE '%\"type\":\"dd96\",\"tag_id\":\"$tag_id\",\"section_id\":\"$av_section_id\",\"section_tipo\":\"$av_section_tipo\"%'";
			}
			$options->sql_filter = implode(" OR ",$ar_filter);

		$rows_data	= (object)web_data::get_rows_data( $options );
		$rows		= !empty($rows_data->result)
			? (array)$rows_data->result
			: [];

		$AR_RESTRICTED_TERMS = defined('AR_RESTRICTED_TERMS') && !empty(AR_RESTRICTED_TERMS)
			? json_decode(AR_RESTRICTED_TERMS)
			: [];
		foreach ($rows as $key => $value) {
			# Remove restricted terms
			if (in_array($value['term_id'], $AR_RESTRICTED_TERMS)) {
				unset($rows_data->result[$key]);
			}
		}
		# Reset array keys
		$rows_data->result = array_values($rows);

		return $rows_data;
	}//end get_indexation_terms_multiple



	/**
	* BUILD_FRAGMENT
	* Get fragment text from tag. Used in search_thematic
	* @param object request_options
	* @return object $result | null
	*	$result->fragment string. Clean text without tags
	*	$result->tcin_secs int. Seconds for video cut in
	*	$result->tcin_secs int. Seconds for video cut out
	*	$result->video_url string. Full video path with tc in and out vars
	* 	$result->posterframe_url string. Full posterframe path
	*/
	public static function build_fragment( $request_options ) {

		mb_internal_encoding('UTF-8');

		// options
			$options = new stdClass();
				$options->tag_id				= null;
				$options->lang					= WEB_CURRENT_LANG_CODE;
				$options->raw_text				= null;
				$options->av_section_id			= null;
				$options->component_tipo		= null;
				$options->section_tipo			= null;
				$options->video_url				= null; # Like 'http://mydomain.org/dedalo/media/av/404/'
				$options->margin_seconds_in		= null;
				$options->margin_seconds_out	= null;
				$options->margin_chars_in		= 0; // 5;	# default 100
				$options->margin_chars_out		= 0; // 100;	# default 100
				$options->fragment_terms_inside	= false; # If true, calculate terms indexed inide this fragment
				$options->indexation_terms		= false; # If true, calculate all terms used in this indexation
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

		// check vars
			if(!empty($options->lang) && !self::check_safe_value('lang', $options->lang)) {
				// die("Error. Illegal lang: ".$options->lang);
				trigger_error("Error. Illegal lang: ".$options->lang);
				return null;
			}
			if(!empty($options->av_section_id) && !self::check_safe_value('section_id', $options->av_section_id)) {
				// die("Error. Illegal av_section_id: ".$options->av_section_id);
				trigger_error("Error. Illegal av_section_id: ".$options->av_section_id);
				return null;
			}

		$result = new stdClass();

		// video filename
			if (is_null($options->video_url)) {
				$base_url	= WEB_VIDEO_BASE_URL;
				$file_name	= AV_TIPO.'_'.$options->section_tipo.'_'.$options->av_section_id.'.mp4';// Like : rsc35_rsc167_1
				$av_path	= $base_url .'/'. $file_name;
			}else{
				$av_path	= $options->video_url;
			}

		// posterframe_url (from server config WEB_VIDEO_BASE_URL like: '/dedalo/media/av/404')
			$base_url			= pathinfo(WEB_VIDEO_BASE_URL)['dirname'];
			$video_id			= AV_TIPO.'_'.$options->section_tipo.'_'.$options->av_section_id;
			$posterframe_url	= $base_url .'/posterframe/'. $video_id .'.jpg';

		// posterframe_tag_url
			$posterframe_tag_url = $base_url .'/posterframe/' . $video_id .'_'. $options->tag_id.'.jpg';

		// tags
			$tag_in		= TR::get_mark_pattern('indexIn',  $standalone=false, $options->tag_id, $data=false);
			$tag_out	= TR::get_mark_pattern('indexOut', $standalone=false, $options->tag_id, $data=false);

		// Build in/out regex pattern to search
			$regexp = $tag_in ."(.*)". $tag_out;

		// Search fragment_text
			# Dato raw from matrix db
			$raw_text = $options->raw_text ?? '';

			// delete_options
				$delete_options =new stdClass();
					$delete_options->deleteTC			= false;
					$delete_options->deleteIndex		= false;
					$delete_options->deleteSvg			= false;
					$delete_options->deleteGeo			= false;
					$delete_options->delete_page		= false;
					$delete_options->delete_person		= true;
					$delete_options->delete_note		= false;
					$delete_options->delete_struct		= false;
					$delete_options->delete_reference	= false;
				#$raw_text = TR::deleteMarks($raw_text, $delete_options); // Force delete  tags

			$raw_text = html_entity_decode($raw_text);

			// PREG_MATCH_ALL
				$preg_match_all_result = preg_match_all("/$regexp/", $raw_text, $matches, PREG_OFFSET_CAPTURE | PREG_SET_ORDER );
				#$preg_match_all_result = _mb_ereg_search_all($raw_text, "/$regexp/u", $resultOrder = 0); $matches = $preg_match_all_result;
				#$preg_match_all_result = free_node::pregMatchCapture($matchAll=true, "/$regexp/", $raw_text, $offset=0);
				// if(SHOW_DEBUG===true) {
					// dump($matches, ' matches preg_match_all_result ++ '.to_string($regexp)); #die();
				// }
			if( !empty($preg_match_all_result) ) {

				$fragment_inside_key	= 3;
				$tag_in_pos_key			= 1;
				$tag_out_pos_key		= 4;

				foreach($matches as $match) {

					if (isset($match[$fragment_inside_key][0])) {

						$fragment_text_raw = $match[$fragment_inside_key][0];

						$fragment_text = $fragment_text_raw;

						// Clean fragment_text
							$fragment_text = TR::deleteMarks($fragment_text);

						// tag in position
							// $tag_in_pos = $match[$tag_in_pos_key][1];

						// tag out position
							// $tag_out_pos = $match[$tag_out_pos_key][1];

						// TC . Time codes
							$indexIN = $match[$tag_in_pos_key][0];
							$tcin = OptimizeTC::optimize_tc_in(
								$raw_text, // string text
								$indexIN, // string indexIN
								null, // int|null start_position
								(int)$options->margin_chars_in  // int in_margin
							);
							$indexOUT = $match[$tag_out_pos_key][0];
							$tcout = OptimizeTC::optimize_tc_out(
								$raw_text, // string text
								$indexOUT, // string indexOUT
								null, // int|null end_position
								(int)$options->margin_chars_out // int in_margin
							);
							// to seconds conversion
							$tcin_secs	= OptimizeTC::TC2seg($tcin);
							$tcout_secs	= OptimizeTC::TC2seg($tcout);

						// TC MARGINS (Optional)
							if (!is_null($options->margin_seconds_in)) {
								$tcin_secs  = OptimizeTC::tc_margin_seconds('in',  $tcin_secs,  $options->margin_seconds_in);
							}
							if (!is_null($options->margin_seconds_out)) {
								$tcout_secs = OptimizeTC::tc_margin_seconds('out', $tcout_secs, $options->margin_seconds_out);
							}

						// VIDEO_URL Like: /dedalo/media/av/404/rsc35_rsc167_1.mp4?vbegin=0&vend=42
							$video_url = $av_path.'?vbegin='.floor($tcin_secs).'&vend='.ceil($tcout_secs);

						// Subtitles url
							$subtitles_url 	= subtitles::get_subtitles_url($options->av_section_id, $tcin_secs, $tcout_secs, $options->lang);

						$result->fragm					= $fragment_text_raw; //$fragment_text; [!IMPORTANTE: DEVOLVER TEXT RAW AQUÍ Y LIMPIAR ETIQUETAS EN EL RESULTADO FINAL !]
						#$result->fragm_raw				= $fragment_text_raw;
						$result->video_url				= $video_url;
						$result->posterframe_url		= $posterframe_url;
						$result->posterframe_tag_url	= $posterframe_tag_url;
						$result->subtitles_url			= $subtitles_url;
						#$result->terms					= array();	// For unify object response only
						#$result->tcin					= $tcin;
						#$result->tcout					= $tcout;
						$result->tcin_secs				= $tcin_secs;
						$result->tcout_secs				= $tcout_secs;

							#dump($result->fragm, '$result->fragm ++ '.to_string($video_url));
						# FRAGMENT_TERMS INSIDE . Sacamos todas las indexaciones y tesauros asociados que incluyen a esta indexacion
						if ($options->fragment_terms_inside===true) {
							# Array of terms in current fragment
							$fragment_before = $fragment_after = $fragment_text_raw;
							$result->fragment_terms_inside = free_node::get_fragment_terms( $options->av_section_id, $fragment_before, $fragment_after, $options->lang );
						}

						# INDEXATION_TERMS . Sacamos todos los término de esta indexacion
						if ($options->indexation_terms===true) {
							$result->terms = web_data::get_indexation_terms( $options->tag_id, $options->av_section_id, $options->lang )->result ;
						}

						return (object)$result;
					}//end if (isset($match[$fragment_inside_key][0])) {
				}//end foreach($matches as $match) {
			}

		return null;
	}//end build_fragment



	/**
	* REMOVE_RESTRICTED_TEXT
	* @return string $text;
	*/
	public static function remove_restricted_text( $raw_text, $av_section_id ) {

		$text = $raw_text;	// Untouched by default

		# Clean text
		#$delete_options = new stdClass();
		#	$delete_options->deleteTC = false;
		#$text = TR::deleteMarks($text, $delete_options);
			#$text = self::decode_dato_html($text);

		$ar_restricted_fragments = self::get_ar_restricted_fragments( $av_section_id );
			#dump($ar_restricted_fragments, ' ar_restricted_fragments ++** '.to_string($av_section_id)); #die();
		foreach ($ar_restricted_fragments as $key => $fragm_obj) {

			// skip replace on some cases (empty, sort text, etc.)
				if (empty($fragm_obj->fragm) || mb_strlen($fragm_obj->fragm)<5) {
					continue;
				}

			// old replace all
				#$text = str_replace($fragm_obj->fragm, ' *** ', $text, $count);

			// replace restricted text ONCE
				$haystack 	= $raw_text;
				$needle 	= $fragm_obj->fragm;
				$replace 	= ' *** ';
				$pos 		= strpos($haystack, $needle);
				if ($pos !== false) {
					$text = substr_replace($haystack, $replace, $pos, strlen($needle));
				}

			if(SHOW_DEBUG===true) {
				error_log("-- Replaced concurrences of fragm (reel $av_section_id - $key)");
			}
		}

		return $text;
	}#end remove_restricted_text



	/**
	* GET_AR_RESTRICTED_FRAGMENTS
	* Calcula toda la información (text fragment, tc's, etc.) de los fragmentos restringidos en esta cinta
	* @param string|int $section_id
	* @return array $ar_restricted_fragments
	*/
	public static function get_ar_restricted_fragments( string|int $section_id ) : array {

		static $ar_restricted_fragments;
		if (isset($ar_restricted_fragments[$section_id])) {
			if(SHOW_DEBUG) {
				error_log(__METHOD__." Result from cache $section_id");
			}
			return $ar_restricted_fragments[$section_id];
		}

		$ar_fragments_from_reel = self::get_ar_fragments_from_reel( $section_id, TERM_ID_RESTRICTED );
			#dump($ar_fragments_from_reel, ' $ar_fragments_from_reel ++ '.to_string(TERM_ID_RESTRICTED));

		if(isset($ar_fragments_from_reel[TERM_ID_RESTRICTED])) {
			foreach ($ar_fragments_from_reel[TERM_ID_RESTRICTED] as $current_locator) {
				$fragment_data = self::get_fragment_data( $section_id, $current_locator->tag_id );
				$ar_restricted_fragments[$section_id][] = $fragment_data;
			}
		}else{
			$ar_restricted_fragments[$section_id] = array();
		}
		#dump($ar_restricted_fragments[$section_id], ' ar_restricted_fragments ++ '.to_string());


		return (array)$ar_restricted_fragments[$section_id];
	}#end get_ar_restricted_fragments



	/**
	* GET_FRAGMENT_DATA
	* Calcula toda la información relativa a un fragmento en base a los datos dados ($section_id, $tag_id)
	* @see search_thematic::build_fragment
	* @return object
	*/
	public static function get_fragment_data( $av_section_id, $tag_id ) {

		// check vars
			if(!empty($av_section_id) && !self::check_safe_value('section_id', $av_section_id)) {
				die("Error. Illegal av_section_id: ".$av_section_id);
			}

		# TRANSCRIPTION
		$options = new stdClass();
			$options->table 		= (string)TABLE_AUDIOVISUAL;
			$options->ar_fields 	= array(FIELD_TRANSCRIPTION);
			$options->sql_filter 	= "section_id = $av_section_id AND lang = '".WEB_CURRENT_LANG_CODE."' " . PUBLICATION_FILTER_SQL;
			$options->order 		= null;
			$options->limit 		= null;

			$rows_data = (object)web_data::get_rows_data( $options );
				#dump($rows_data, ' rows_data'); die();

		if(empty($rows_data->result)) {
			return null;
		}
		$raw_text = reset($rows_data->result)[FIELD_TRANSCRIPTION];
			#dump($raw_text, ' $raw_text ++ '.to_string($options)); die();

		# FRAGMENTS

		#
		# FRAGMENT DATA
		# Create fragment and tesaurus associated
		$options = new stdClass();
			$options->tag_id 			 = $tag_id;
			$options->av_section_id  	 = $av_section_id;
			$options->component_tipo 	 = DEDALO_COMPONENT_RESOURCES_AV_TIPO;
			$options->section_tipo 	 	 = DEDALO_SECTION_RESOURCES_AV_TIPO;
			$options->video_url 	 	 = '';	//$video_url; # Like 'http://mydomain.org/dedalo/media/av/404/'
			$options->margin_seconds_in  = null;
			$options->margin_seconds_out = null;
			$options->margin_chars_in 	 = 0;	# default 100
			$options->margin_chars_out	 = 0;	# default 100
			$options->raw_text 			 = $raw_text;

			$fragments_obj = web_data::build_fragment( $options );
				#dump($fragments_obj, ' fragments_obj ++ '.to_string()); die();

		return $fragments_obj;
	}#end get_fragment_data



	/**
	* GET_AR_FRAGMENTS_FROM_REEL
	* Calcula los locators (por tanto los tags) de las indexaciones hacia esta cinta y los agrupa por terminoID
	* Nótese el orden del filtro, que busca en un array de locators codificado json como string de tipo:
	* 	[{"section_top_tipo":"oh1","section_top_id":"30","section_tipo":"rsc167","section_id":"39","component_tipo":"rsc36","tag_id":"25"}]
	* Se usa por ejemplo para despejar los fragmentos restringidos dentro de una transcripción
	* E.g.
	* [rt1] => Array
	*    (
	*        [0] => stdClass Object
	*            (
	*                [section_top_tipo] => oh1
	*                [section_top_id] => 2
	*                [section_tipo] => rsc167
	*                [section_id] => 2
	*                [component_tipo] => rsc36
	*                [tag_id] => 69
	*            )
	* @return array $ar_locators
	*/
	public static function get_ar_fragments_from_reel( $section_id, $term_id=false, $section_tipo=AUDIOVISUAL_SECTION_TIPO ) {

		// check vars
			if(!empty($section_id) && !self::check_safe_value('section_id', $section_id)) {
				die("Error. Illegal section_id: ".$section_id);
			}
			if(!empty($term_id) && !self::check_safe_value('term_id', $term_id)) {
				die("Error. Illegal term_id: ".$term_id);
			}
			if(!empty($section_tipo) && !self::check_safe_value('section_tipo', $section_tipo)) {
				die("Error. Illegal section_tipo: ".$section_tipo);
			}

		$field_indexation = defined('FIELD_INDEX') ? FIELD_INDEX : 'indexation';

		// "section_id":"40","section_tipo":"rsc167","component_tipo":"rsc36"
		// $filter = "(`index` LIKE '%\"section_tipo\":\"$section_tipo\",\"section_id\":\"$section_id\"%')";
		$filter = "(`{$field_indexation}` LIKE '%\"section_id\":\"$section_id\",\"section_tipo\":\"$section_tipo\"%')";
					// OR `{$field_indexation}` LIKE '%\"section_tipo\":\"$section_tipo\",\"section_id\":\"$section_id\"%')";

		if ($term_id) {
			$filter = "`term_id` = '$term_id' AND $filter ";
		}

		$options = new stdClass();
			$options->table			= (string)TABLE_THESAURUS;
			$options->ar_fields		= ['term_id',$field_indexation];
			$options->sql_filter	= $filter; 	// !IMPORTANT : NEVER USE PUBLICATION FILTER HERE // ." AND lang = '".WEB_CURRENT_LANG_CODE."' "
			$options->lang			= WEB_CURRENT_LANG_CODE;
			$options->order			= null;
			$options->limit			= null;

			$rows_data = (object)web_data::get_rows_data( $options );
				#dump($rows_data, ' rows_data - term_id: '.$term_id); #die();

		if (empty($rows_data->result)) {
			return array(); // Current reel don't have relations with this term
		}

		$ar_locators = array();
		foreach ((array)$rows_data->result as $ar_value) {

			$current_term_id 	= $ar_value['term_id'];
			$ar_index  			= !empty($ar_value[$field_indexation])
				? json_decode($ar_value[$field_indexation])
				: [];
				#dump($ar_index, ' ar_index ++ '.to_string());
			foreach ((array)$ar_index as $key => $locator) {
				if ($locator->section_tipo==$section_tipo && $locator->section_id==$section_id) {
					$ar_locators[$current_term_id][] = $locator;
				}
			}
		}
		#dump($ar_locators, ' ar_locators ++ '.to_string()); die();

		return $ar_locators;
	}#end get_ar_fragments_from_reel



	/* THESAURUS
	----------------------------------------------------------------------- */



		/**
		* GET_THESAURUS_ROOT_LIST
		* Return a array of 'ts_term' objects with resolved data
		* You can use only the data or (in PHP) manage 'ts_term' objects
		* to build custom html
		* @return array $ar_ts_terms
		*	ts_terms objects are instances of ts_terms.class element
		*/
		public static function get_thesaurus_root_list( $request_options ) {
			// Globals from config
			global $table_thesaurus_map, $thesaurus_root_list_parents;

			$options = new stdClass();
				$options->table  			= (string)TABLE_THESAURUS;
				$options->parents  			= isset($thesaurus_root_list_parents) ? $thesaurus_root_list_parents : false;
				$options->exclude_tld 		= array("xx");
				$options->lang 		 		= WEB_CURRENT_LANG_CODE;
				$options->order 			= "`norder` ASC";
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}
					// dump($options, '$options ++ '.to_string());

			// table is always a string. If array is received, implode as comma separated string
				$table = (is_array($options->table))
					? implode(',', $options->table)
					: trim($options->table);

			// check vars
				if(!empty($options->table) && !self::check_safe_value('table', $options->table)) {
					die("Error. Illegal table: ".$options->table);
				}
				if(!empty($options->lang) && !self::check_safe_value('lang', $options->lang)) {
					die("Error. Illegal lang: ".$options->lang);
				}
				if(!empty($options->order) && !self::check_safe_value('order', $options->order)) {
					die("Error. Illegal order: ".$options->order);
				}

			if ($options->parents!==false) {

				# When is user send var, is string comma separated list of terms
				if (is_string($options->parents) && strpos($options->parents, ',')!==false) {
					$options->parents = explode(',', $options->parents);
				}

				# CUSTOM PARENTS
				$ar_value = array();
				foreach ((array)$options->parents as $parent) {

					$ar  = explode('_', $parent);
					$tld = $ar[0];
					if ($tld==='hierarchy1') {
						$tld = $parent; // Full like hierarchy1_246

						# Resolve parent term name
						$options_hierarchy = new stdClass();
							$options_hierarchy->table 		= TABLE_HIERARCHY;
							$options_hierarchy->ar_fields 	= array('name');
							$options_hierarchy->lang 	 	= $options->lang;
							$options_hierarchy->sql_filter  = "`section_id` = ".(int)$ar[1];
							$options_hierarchy->limit 		= 1;
							$options_hierarchy->order 		= '';
						$rows_data	= (object)web_data::get_rows_data( $options_hierarchy );

						$parent_term = isset($rows_data->result[0]) ? $rows_data->result[0]['name'] : '';

					}else{

						# Resolve parent term name
						$options_hierarchy = new stdClass();
							$options_hierarchy->table 		= $table;
							$options_hierarchy->ar_fields 	= array('term');
							$options_hierarchy->lang 	 	= $options->lang;
							$options_hierarchy->sql_filter  = "`section_id` = ".(int)$ar[1];
							$options_hierarchy->limit 		= 1;
							$options_hierarchy->order 		= '';
						$rows_data	= (object)web_data::get_rows_data( $options_hierarchy );
							#dump($rows_data, ' rows_data ++ '.to_string($options_hierarchy));
						#$parent_term = reset($rows_data->result)['term'];
						$parent_term = isset($rows_data->result[0]) ? $rows_data->result[0]['term'] : '';
					}

					$ar_value[] = [
						'tld'		=> $tld,
						'term_id'	=> $parent,
						'term'		=> $parent_term
					];
				}
				$rows_data = new stdClass();
					$rows_data->result = $ar_value;

			}else{
				# DISTINCT TESAURUS (TLD)
					# Get all different thesaurus tld
					$rd_options = new stdClass();
						$rd_options->table 		= $table;
						$rd_options->ar_fields 	= array('DISTINCT tld AS tld');
						#$rd_options->order 	= $options->order;
						$rd_options->order 		= "";

					$rows_data	= (object)web_data::get_rows_data( $rd_options );
						#dump($rows_data, ' rows_data ++ '.to_string($table));
			}



			# THESAURUS ROOT LEVEL TERMS
				# Get data from each term
				$ar_ts_terms=array();
				$ar_restricted_terms = defined('AR_RESTRICTED_TERMS') && !empty(AR_RESTRICTED_TERMS)
					? json_decode(AR_RESTRICTED_TERMS)
					: [];
				foreach ((array)$rows_data->result as $ar_value) {

					if (empty($ar_value)) {
						continue;
					}

					$current_tld = $ar_value['tld'];
						# Skip excluded tlds
						if (in_array($current_tld, $options->exclude_tld)) {
							continue;
						}

					# term_id
					if ($options->parents!==false) {
						$term_id = $ar_value['term_id'];
					}else{
						$term_id = $current_tld.'_1';	// NÓTESE QUE SIEMPRE USAMOS '1' COMO ROOT EN LUGAR DE '0'
					}

					# Skip optional restricted terms (defined in config)
					if (in_array($term_id, $ar_restricted_terms)) {
						continue;
					}

					// term
					$term = $ar_value['term'] ?? '';

					# Table optimized version contains only possible table instead all tables (reduce union query time)
					$thesaurus_table = $table;
					foreach ($table_thesaurus_map as $tkey => $tvalue) {
						if (strpos($term_id, $tkey)===0) {
							$thesaurus_table = $tvalue; break;
						}
					}
					#dump($thesaurus_table, ' thesaurus_table ++ '.to_string($term_id));

					$ar_children = ts_term::get_ar_children($term_id, $thesaurus_table);
						// dump($ar_children, '$ar_children ++ term_id: '.$term_id." - thesaurus_table: ".to_string($thesaurus_table));

					foreach ($ar_children as $current_term_id) {

						# Skip optional restricted terms (defined in config)
						if (in_array($current_term_id, $ar_restricted_terms)) {
							continue;
						}

						# Create a object 'ts_term' and get term info
						$ts_term_options = new stdClass();
							$ts_term_options->table 	  = $thesaurus_table;
							$ts_term_options->parent_term = $term;
						$ts_term = ts_term::get_ts_term_instance($current_term_id, $options->lang , $ts_term_options);

						# Force to load data from database
						$ts_term->load_data();

						$ar_ts_terms[$current_tld][] = $ts_term;
					}

				}//end foreach ((array)$rows_data->result) as $current_tld)

			$response = new stdClass();
				$response->result = (array)$ar_ts_terms;


			return $response;
		}//end get_thesaurus_root_list



		/**
		* GET_THESAURUS_RANDOM_TERM
		* Return a random term from thesaurus tables
		* @return string $random_term
		*/
		public static function get_thesaurus_random_term( $request_options ) {

			$options = new stdClass();
				$options->table  	 			 = (string)TABLE_THESAURUS;
				$options->exclude_tld 			 = array("xx");
				$options->lang 		 			 = WEB_CURRENT_LANG_CODE;
				$options->publication_filter_sql = '';
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			// check vars
				if(!empty($options->table) && !self::check_safe_value('table', $options->table)) {
					die("Error. Illegal table: ".$options->table);
				}
				if(!empty($options->lang) && !self::check_safe_value('lang', $options->lang)) {
					die("Error. Illegal lang: ".$options->lang);
				}
				if(!empty($options->publication_filter_sql) && !self::check_safe_value('sql_filter', $options->publication_filter_sql)) {
					die("Error. Illegal publication_filter_sql: ".$options->publication_filter_sql);
				}

			$field_term 	= FIELD_TERM;
			$field_term_id 	= FIELD_TERM_ID;

			$exclude_filter = '';
			$ar = array();
			foreach ($options->exclude_tld as $tld) {

				if(!empty($tld) && !self::check_safe_value('term_id', $tld)) {
					die("Error. Illegal tld: ".$tld);
				}

				$ar[] = "tld != '$tld'";
			}
			$exclude_filter = ' AND ('.implode(' AND ',$ar).')';

			$lang_filter 	= " AND lang = '".$options->lang."' ";

			$field_indexation = defined('FIELD_INDEX') ? FIELD_INDEX : 'indexation';

			#
			# RANDOM TERM
			$sd_options = new stdClass();
				$sd_options->table 		= $options->table;
				$sd_options->ar_fields 	= array($field_term, $field_term_id,$field_indexation);
				$sd_options->sql_filter = "(`{$field_indexation}` != '' AND `{$field_indexation}` != '[]') ". $lang_filter . $exclude_filter . $options->publication_filter_sql;
				$sd_options->order 		= "RAND()";
				$sd_options->limit 		= 1;
			$search_data	= (object)web_data::get_rows_data( $sd_options );

			$row = reset($search_data->result);

			$response = new stdClass();
				$response->term 		= $row[$field_term];
				$response->term_id 		= $row[$field_term_id];
				$response->indexation 	= $row[$field_indexation];

			return (object)$response;
		}//end get_thesaurus_random_term



		/**
		* GET_THESAURUS_SEARCH
		* @return object $response
		*	$response->search_data stdClass
		*	$response->ar_ts_terms array of 'ts_term' objects
		*	$response->ar_highlight array of terms located in search
		*/
		public static function get_thesaurus_search( $request_options ) {

			$options = new stdClass();
				$options->q							= false;
				$options->table						= TABLE_THESAURUS;
				$options->lang						= WEB_CURRENT_LANG_CODE;
				$options->rows_per_page				= 1;
				$options->page_number				= 1;
				$options->exclude_tld				= array("xx");
				$options->tree_root					= 'last_parent'; # first_parent | last_parent
				$options->publication_filter_sql	= '';
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			// check vars
				if(!empty($options->q) && !self::check_safe_value('sql_filter', $options->q)) {
					die("Error. Illegal q: ".$options->q);
				}
				if(!empty($options->table) && !self::check_safe_value('table', $options->table)) {
					die("Error. Illegal table: ".$options->table);
				}
				if(!empty($options->lang) && !self::check_safe_value('lang', $options->lang)) {
					die("Error. Illegal lang: ".$options->lang);
				}
				if(!empty($options->rows_per_page) && !self::check_safe_value('limit', $options->rows_per_page)) {
					die("Error. Illegal rows_per_page: ".$options->rows_per_page);
				}
				if(!empty($options->publication_filter_sql) && !self::check_safe_value('sql_filter', $options->publication_filter_sql)) {
					die("Error. Illegal publication_filter_sql: ".$options->publication_filter_sql);
				}

			$field_term = FIELD_TERM;

			# Offset
			$offset = 0;
			if ($options->page_number>1) {
				$offset = ($options->page_number-1) * $options->rows_per_page;
			}

			# q (real_escape_string)
			$q = $options->q;
			if ($q!==false) {
				$q = web_data::get_db_connection()->real_escape_string($q);
			}


			# Search in DDBB
			$rd_options = new stdClass();
				$rd_options->table 			= $options->table;
				$rd_options->ar_fields 		= array('*');
				$rd_options->sql_filter 	= "`$field_term` LIKE '%".$q."%' " . $options->publication_filter_sql;
				$rd_options->lang 			= $options->lang;
				$rd_options->order 			= null; // $field_term.' ASC';
				$rd_options->limit 			= $options->rows_per_page;
				$rd_options->offset 		= $offset;
				$rd_options->count 			= true;
			$search_data = (object)web_data::get_rows_data( $rd_options );

			# Safe descriptors
			foreach ($search_data->result as $key => $value_obj) {
				#dump((object)$value_obj, ' $value_obj ++ '.to_string());
				$search_data->result[$key] = (array)web_data::no_descriptor_to_descriptor( (object)$value_obj );
			}
			#dump($search_data, ' search_data ++ '.to_string());

			# Add vars for pagination
			$search_data->page_number	= $options->page_number;
			$search_data->rows_per_page	= $options->rows_per_page;

			$field_indexation = defined('FIELD_INDEX') ? FIELD_INDEX : 'indexation';

			$ar_ts_terms	= array();
			$ar_highlight	= array();
			$ar_parent		= array();
			foreach ((array)$search_data->result as $ar_value) {

				$tld		= $ar_value['tld'];
				$term_id	= $ar_value['term_id'];
				$term		= $ar_value[$field_term];
				$parent		= $ar_value['parent'];
				$descriptor	= $ar_value['descriptor']; // es descriptor: no | yes
				$indexation	= $ar_value[$field_indexation];

				if (strpos($parent,'[')===0) {
					# is json array
					$ar_parent	= json_decode($parent);
					$parent		= reset($ar_parent); // Select first (only one expected)
				}

				#
				# AR_PARENT . PATH OF ALL PARENTS KRSORTED
				$ar_parent = ts_term::get_ar_parent( $parent, $tld );
					#dump($ar_parent, ' ar_parent ++ '.to_string()); die();

				###
				/*if (reset($ar_parent)) {	// Important. Keys ar not numerics. Don't use '$ar_parent[0]'
					$first_parent = reset($ar_parent);
				}else{
					$first_parent = $parent;
				}

				$ts_term = ts_term::get_ts_term_instance($first_parent, $options->lang, $options_ts_term=null);
				$ts_term->load_data(); // Force load db data
				$ar_ts_terms[$tld][] = $ts_term;*/
				###

				/*
				foreach ($ar_parent as $key => $cparent) {
					if (strpos($cparent, 'hierarchy')!==false) continue;
					$ts_term 			 = ts_term::get_ts_term_instance($cparent, $options->lang, $options_ts_term=null);
					$ar_ts_terms[$tld][] = $ts_term;
					break; // Stop in first level
				}*/

				#
				# ROOT_PARENT
				# Select parent from create tree
				# Can be 'first_parent' to create complete tree from root to searched term (x levels) and
				# 'last_parent' for create the tree only from precedent term (1 level)
				if ($options->tree_root==='first_parent') {
					$root_parent = reset($ar_parent);
				}else{
					$root_parent = end($ar_parent);
				}

				if (empty($root_parent)) {
					# No root parent case. If parent is empty set current term as first root element
					$ts_term_options = new stdClass();
						$ts_term_options->table = $options->table;
						#$ts_term_options->term 		 = $term;
						#$ts_term_options->indexation = $indexation;
					$ts_term 			 = ts_term::get_ts_term_instance($term_id, $options->lang, $ts_term_options);
					$ts_term->load_data(); // Force load db data
					$ar_ts_terms[$tld][] = $ts_term;

				}else{
					# Normal case
					$ts_term_options = new stdClass();
						$ts_term_options->table 	 = $options->table;
						#$ts_term_options->term 		 = $term;
						#$ts_term_options->indexation = $indexation;
					$ts_term 			 = ts_term::get_ts_term_instance($root_parent, $options->lang, $ts_term_options);
					$ts_term->load_data(); // Force load db data
					$ar_ts_terms[$tld][] = $ts_term;
				}


				# highlight add
				$ar_highlight[] = $term_id;
				break;
			}//end foreach ((array)$search_data->result) as $tld)
			#dump($ar_ts_terms, ' ar_ts_terms ++ '.to_string()); die();

			$response = new stdClass();
				$response->search_data	= $search_data;
				$response->ar_ts_terms	= $ar_ts_terms;
				$response->ar_highlight	= $ar_highlight;
				$response->ar_parent	= $ar_parent;
			#dump($response, ' response ++ '.to_string()); #exit();

			return $response;
		}//end get_thesaurus_search



		/**
		* NO_DESCRIPTOR_TO_DESCRIPTOR
		* @return
		*/
		public static function no_descriptor_to_descriptor( $term_obj ) {
			#dump($term_obj, ' term_obj ++ '.to_string());

			if (!isset($term_obj->descriptor) || $term_obj->descriptor!=='no') {
				# Term is descriptor
				$descriptor_obj = $term_obj;
			}else{

				// check vars
					if(!empty($term_obj->parent) && !self::check_safe_value('term_id', $term_obj->parent)) {
						die("Error. Illegal term_obj->parent: ".$term_obj->parent);
					}

				# Term is NOT descriptor
				# Search parent descriptor
				# Search in DDBB
				$rd_options = new stdClass();
					$rd_options->table		= $term_obj->table;
					$rd_options->ar_fields	= array('*');
					$rd_options->sql_filter	= FIELD_TERM_ID ."='$term_obj->parent'";
					$rd_options->lang		= $term_obj->lang;
					$rd_options->order		= null;
					$rd_options->limit		= 1;
				$search_data = (object)web_data::get_rows_data( $rd_options );

				if (!empty($search_data->result)) {
					$term_obj_descriptor = reset($search_data->result);
					# Add note to term
					$term_obj_descriptor['term'] .= " <small class=\"notaND\">(x {$term_obj->term})</small>";
					#$term_obj_descriptor['term'] .= " (x {$term_obj->term})";

					$descriptor_obj = $term_obj_descriptor;
				}else{

					error_log("ERROR ON GET PARENT DESCRIPTOR FOR NON DESCRIPTOR $term_obj->term_id . Original NON descriptor is returned !!");
					$descriptor_obj = $term_obj;
				}
			}
			#dump($descriptor_obj, ' descriptor_obj ++ '.to_string());

			return $descriptor_obj;
		}//end no_descriptor_to_descriptor



		/**
		* GET_THESAURUS_AUTOCOMPLETE
		* Search string in database (begings with $q) and get array of max 25 records
		* @param object $request_options
		* @return oject $response
		* 	$response->result Array of terms like 'born'
		*/
		public static function get_thesaurus_autocomplete( $request_options ) {

			$options = new stdClass();
				$options->q			= false;
				$options->limit		= 25;
				$options->table		= TABLE_THESAURUS;
				$options->lang		= WEB_CURRENT_LANG_CODE;
				$options->format	= 'simple'; // simple | full
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			$field_term = FIELD_TERM;

			# q scape
			if ($options->q!==false) {
				$options->q = web_data::get_db_connection()->real_escape_string($options->q);
			}

			if ($options->q!==false) {

				$sd_options = new stdClass();
					$sd_options->table		= $options->table;
					$sd_options->ar_fields	= array($field_term, 'term_id');
					$sd_options->sql_filter	= "`$field_term` LIKE '%".$options->q."%'";
					$sd_options->order		= $field_term ." ASC";
					$sd_options->lang		= $options->lang ;
					$sd_options->limit		= $options->limit;

				$search_data	= (object)web_data::get_rows_data( $sd_options );

				$result = array();
				if ($options->format==='full') {
					foreach ((array)$search_data->result as $item) {
						$result[] = (object)$item; // set whole item as object value
					}
				}else{
					foreach ((array)$search_data->result as $item) {
						$value = $item[$field_term]; // select only the term as string value
						$result[] = $value;
					}
				}

				$response = new stdClass();
					$response->result	= $result;
					$response->msg		= 'Ok. Request done';
			}else{

				$response = new stdClass();
					$response->result	= false;
					$response->msg		= 'Error. Empty search value (q)';
			}

			return (object)$response;
		}//end get_thesaurus_autocomplete



		/**
		* GET_THESAURUS_TERM
		* @return object $response
		*	$response->result array List of ts_term objects
		*	$response->msg string Message to developer like ok / error
		*/
		public static function get_thesaurus_term( $request_options ) {
			// Globals from config
			global $table_thesaurus_map;

			$options = new stdClass();
				$options->ar_term_id			= null;
				$options->lang					= WEB_CURRENT_LANG_CODE;
				$options->table					= (string)TABLE_THESAURUS;
				$options->combine				= false;  # false | combined | cumulative
				$options->get_matching_terms	= false; # boolean
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			// ar_term_id. Could be an array or a JSON array or a coma separated terms
				if (is_array($options->ar_term_id)) {
					$ar_term_id = $options->ar_term_id;
				}else{
					if (!empty($options->ar_term_id)) {
						if(!$ar_term_id = json_decode($options->ar_term_id)) {
							$ar_term_id = explode(',',$options->ar_term_id);
						}
					}else{
						$ar_term_id = [];
					}
				}
				$ar_term_id = array_map(function($term_id){
					return trim($term_id);
				}, (array)$ar_term_id);

			// short vars
				$table				= $options->table;
				$lang				= $options->lang;
				$combine			= $options->combine;
				$get_matching_terms	= $options->get_matching_terms;

			$ar_thesaurus_term = array();
			foreach( (array)$ar_term_id as $term_id ) {

				# Skip optional restricted terms (defined in config)
					#if (in_array($term_id, $ar_restricted_terms)) {
					#	continue;
					#}

				# Table optimized version contains only possible table instead all tables (reduce union query time)
				$thesaurus_table = $table;
				foreach ($table_thesaurus_map as $tkey => $tvalue) {
					if (strpos($term_id, $tkey)===0) {
						$thesaurus_table = $tvalue; # break;
					}
				}

				$ts_term_options = new stdClass();
					$ts_term_options->table = $thesaurus_table;
				$ts_term 			 = ts_term::get_ts_term_instance($term_id, $lang, $ts_term_options);
				$ts_term->load_data(); // Force load db data
					#dump($ts_term, ' ts_term ++ '.to_string());
				$ar_thesaurus_term[] = $ts_term;
			}
			#dump($ar_thesaurus_term, ' $ar_thesaurus_term ++ '.to_string()); die();
			#debug_log(__METHOD__."  ar_thesaurus_term ".to_string($ar_thesaurus_term), logger::DEBUG);

			# Combine results
			# No is necessary set combine_terms value. var ar_thesaurus_term is edited directly into the method
			$matching_terms = false;
			if ($combine!==false && count($ar_term_id)>1) {
				$combine_options = new stdClass();
					$combine_options->ar_term_id			= $ar_term_id;
					$combine_options->mode					= $combine;
					$combine_options->ar_ts_terms			= $ar_thesaurus_term;
					$combine_options->get_matching_terms	= $get_matching_terms;
					$combine_options->lang					= $lang;
				$combine_result = web_data::combine_terms( $combine_options ); // $ar_thesaurus_term =
				$matching_terms = $combine_result->matching_terms;
			}

			$response = new stdClass();
				$response->result			= $ar_thesaurus_term;
				$response->matching_terms	= $matching_terms;
				$response->msg				= 'Ok. Request done';


			return $response;
		}//end get_thesaurus_term



		/**
		* COMBINE_TERMS
		* Combines more than 1 term indexations. Used in thematic combinated search modes
		* This method uses method "thesaurus_terms" and recombines the result, all in one call
		* Modes:
		* 	combined : search intersections in locators
		*	cumulative : uses all locators of each term
		* @return object $response
		*/
		public static function combine_terms( $request_options ) {

			$options = new stdClass();
				# options to send at 'get_thesaurus_term'
				$options->ar_term_id			= array();
				$options->ar_ts_terms			= array();
				$options->lang					= WEB_CURRENT_LANG_CODE;
				$options->mode					= 'combined'; # Available: combined | cumulative
				$options->get_matching_terms	= false;
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			#$ts_terms 	 = web_data::get_thesaurus_term( $options );
			#$options->ar_ts_terms = $ts_terms->result;

			if (count((array)$options->ar_term_id)<2) return false;

			# matching_terms
			$matching_terms = array();

			switch ($options->mode) {

				case 'combined':
					# Prepare a global array with all indexations groupped by term_id
					$ar_indexation   = array();
					$ar_used_term_id = array();
					foreach ((array)$options->ar_ts_terms as $key => $ts_object) {
						$ar_used_term_id[] = $ts_object->term_id;
						$ar_locators = json_decode($ts_object->indexation);
						foreach ($ar_locators as $c_locator) {
							$key_compare = $c_locator->section_tipo.'_'. $c_locator->section_id.'_'. $c_locator->tag_id;
							$ar_indexation[$ts_object->term_id][] = $key_compare;	//json_encode($c_locator);
						}
					}
					// remove array indexes
					$ar_indexation = array_values($ar_indexation);
					#dump($ar_indexation, ' ar_indexation ++ '.to_string());

					# Resolve simple intersections
					$ar_indexation_resolved = (array)call_user_func_array('array_intersect',$ar_indexation);
						#dump($ar_indexation_resolved, ' ar_indexation_resolved ++ '.to_string());

					# Add real locators coincident with resolved intersections
					$intersect_locators = array();
					foreach ((array)$options->ar_ts_terms as $key => $ts_object) {
						$ar_locators = json_decode($ts_object->indexation);
						foreach ($ar_locators as $lkey => $c_locator) {
							$key_compare = $c_locator->section_tipo.'_'. $c_locator->section_id.'_'. $c_locator->tag_id;
							if (true===in_array($key_compare, $ar_indexation_resolved)) {
								$intersect_locators[] = json_encode($c_locator);
							}else{
								$ar_excluded_locators[] = $c_locator;
							}
						}
					}

					# Remove duplicates
					$intersect_locators = array_unique($intersect_locators);
					$total_intersect_locators = count($intersect_locators);

					# Format intersect_locators as json encoded array of locators (instead array of strings)
					$ar=array();
					foreach ($intersect_locators as $key => $value) {
						$ar[] = json_decode($value);
					}
					$intersect_locators = json_encode($ar);

					# Add result to each ts_term object replacing old indexation value
					foreach ((array)$options->ar_ts_terms as $key => $ts_object) {
						// Overwrite old value with validated locators
						$ts_object->indexation = $intersect_locators;	//json_encode($intersect_locators);
					}
					#dump($options->ar_ts_terms, ' $options->ar_ts_terms ++ '.to_string());

					# Search matching terms
					# Matching terms are other terms that appears on same indexations (current indexation locators)
					# Iterate current indexation locators
					if ($options->get_matching_terms===true && $total_intersect_locators>0) {

						$first_ts_term = reset($options->ar_ts_terms); // Only one is useful (all term indexation are identical)
						$ar_indexation = json_decode($first_ts_term->indexation);
							#dump($indexation, ' indexation ++ '.to_string());
						$matching_terms = array();
						$ar_temp_matching_terms = web_data::get_indexation_terms_multiple( $ar_indexation, $options->lang );
						foreach ((array)$ar_temp_matching_terms->result as $key => $ar_value) {
								#dump($ar_value, ' ar_value ++ '.to_string());
								if ( !in_array($ar_value['term_id'], $ar_used_term_id) ) {
									$matching_terms[] = $ar_value;
								}
							}
						/*
						foreach ((array)$ar_indexation as $current_locator) {
							$ar_temp_matching_terms = web_data::get_indexation_terms( $current_locator->tag_id, $current_locator->section_id, $options->lang );

							# dump($ar_temp_matching_terms, ' ar_temp_matching_terms ++ '.to_string());
							foreach ((array)$ar_temp_matching_terms->result as $key => $ar_value) {
								#dump($ar_value, ' ar_value ++ '.to_string());
								if ( !in_array($ar_value['term_id'], $ar_used_term_id) ) {
									$matching_terms[] = $ar_value;
								}
							}
						}*/
					}//end if ($options->get_matching_terms===true)
					break;

				case 'cumulative':
					# Create a global array of indexations
					break;
			}
			#dump($options->ar_ts_terms, '$options->ar_ts_terms ++ '.to_string());

			$response = new stdClass();
				$response->result			= true;
				$response->ar_ts_terms		= $options->ar_ts_terms;
				$response->matching_terms	= $matching_terms;
				$response->msg				= 'Ok. Request successful';

			return $response;
		}//end combine_terms



		/**
		* GET_THESAURUS_INDEXATION_NODE
		* @return object $response
		*	$response->result array List of indexation_node objects
		*	$response->msg string Message to developer like ok / error
		*/
		public static function get_thesaurus_indexation_node( $request_options ) : object {

			$options = new stdClass();
				$options->term_id		= null;
				$options->ar_locators	= null;
				$options->lang			= WEB_CURRENT_LANG_CODE;
				$options->image_type	= 'posterframe'; # posterframe | identify_image
				$options->table			= null; // only used when ar_locators is empty
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			// empty ar_locators case
				if (empty($options->ar_locators)) {

					$ind_options = new stdClass();
						$ind_options->table			= (string)$options->table;
						$ind_options->ar_fields		= array('section_id',FIELD_INDEX);
						$ind_options->lang			= $options->lang;
						$ind_options->sql_filter	= '`term_id` = \''.$options->term_id.'\' ';

					$indexation_response = (object)web_data::get_rows_data( $ind_options );
					if (isset($indexation_response->result[0])) {
						$options->ar_locators = $indexation_response->result[0][FIELD_INDEX];
					}
				}

			if (is_string($options->ar_locators)) {
				$options->ar_locators = json_decode($options->ar_locators);
			}

			# Valid ar_locators is mandatory
			if (empty($options->ar_locators)) {
				$response = new stdClass();
					$response->result	= array();
					$response->msg		= 'Error. Valid ar_locators is mandatory. Received: '.to_string($options->ar_locators);
				return $response;
			}

			$ar_indexation_node = array();
			foreach ( (array)$options->ar_locators as $current_locator ) {

				// check tag_id in locator
					if (!isset($current_locator->tag_id)) {
						error_log('current_locator do not have tag_id. Ignored locator ! '. PHP_EOL . json_encode($current_locator, JSON_PRETTY_PRINT));
						debug_log(__METHOD__
							." current_locator do not have tag_id. Ignored locator !". PHP_EOL
							.' current_locator: ' . json_encode($current_locator, JSON_PRETTY_PRINT)
							, logger::ERROR
						);
						continue;
					}

				// Safe ar_locators (avoid show info of locators without interview / audiovisual)
					$locator_av_section_id			= $current_locator->section_id;
					$locator_interview_section_id	= $current_locator->section_top_id;
					if(false===web_data::record_is_active(TABLE_INTERVIEW, $locator_interview_section_id)) {
						debug_log(__METHOD__." INTERVIEW NOT ACTIVE SKIPPED !! ".to_string($locator_interview_section_id), logger::DEBUG);
						continue;
					}
					if(false===web_data::record_is_active(TABLE_AUDIOVISUAL, $locator_av_section_id)) {
						debug_log(__METHOD__." AUDIOVISUAL NOT ACTIVE SKIPPED !! ".to_string($locator_av_section_id), logger::DEBUG);
						continue;
					}

				// indexation node
					$indexation_node = indexation_node::get_indexation_node_instance($options->term_id, $current_locator, null);
					if (empty($indexation_node)) {

						debug_log(__METHOD__
							." indexation_node invalid !! Ignored.". PHP_EOL
							.' current_locator: ' . to_string($current_locator)
							, logger::ERROR
						);
						continue;
					}

					$indexation_node->image_type	= $options->image_type ?? 'posterframe';
					$indexation_node->indexations	= $options->ar_locators;
					$indexation_node->lang			= $options->lang;
					$indexation_node->load_data(); # Force load object data from DDBB
					# Unset temporal property of indexation_node object for clean json data
					unset($indexation_node->indexations);
					# Remove temporal vars to clean data output
					unset($indexation_node->options);

				// add node
					$ar_indexation_node[] = $indexation_node;
			}//end foreach ( (array)$options->ar_locators as $current_locator )


			$response = new stdClass();
				$response->result	= $ar_indexation_node;
				$response->msg		= 'OK. Request thesaurus_indexation_node done';


			return $response;
		}//end get_thesaurus_indexation_node



		/**
		* RECORD_IS_ACTIVE
		* @return bool
		*/
		public static function record_is_active($table, $section_id, $lang=WEB_CURRENT_LANG_CODE) {

			$record_is_active = false;

			$s_options = new stdClass();
				$s_options->table		= (string)$table;
				$s_options->ar_fields	= array('section_id');
				$s_options->lang		= $lang;
				$s_options->section_id	= $section_id;

			$response = (object)web_data::get_rows_data( $s_options );

			if (!empty($response->result)) {
				$record_is_active = true;
			}


			return (bool)$record_is_active;
		}//end record_is_active



		/**
		* GET_THESAURUS_VIDEO_VIEW_DATA
		* @return object $response
		*/
		public static function get_thesaurus_video_view_data( $request_options ) {

			$options = new stdClass();
				$options->term_id				= null;
				$options->ar_locators			= null;
				$options->ar_locators_key		= 0;
				$options->lang					= WEB_CURRENT_LANG_CODE;
				$options->raw_text				= false;
				$options->raw_text_unrestricted	= false;
				$options->add_subtitles			= false;
				$options->image_type			= 'posterframe';
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			$video_view_options = new stdClass();
				$video_view_options->lang			= $options->lang;
				$video_view_options->add_subtitles	= $options->add_subtitles;
			$video_view_data = new video_view_data( $video_view_options );
			$video_view_data->load_thesaurus_video_view_data( $options->term_id, $options->ar_locators, $options->ar_locators_key );


			if ($options->raw_text===false) {
				unset($video_view_data->raw_text);
			}
			if ($options->raw_text_unrestricted===false) {
				unset($video_view_data->raw_text_unrestricted);
			}

			return $video_view_data;
		}//end get_thesaurus_video_view_data



		/**
		* GET_THESAURUS_CHILDREN
		* @return object $response
		*/
		public static function get_thesaurus_children( $request_options ) {
			global $table_thesaurus_map; // From server api config

			// various case like ts1_1,ts1_2. Use 'request_options->multiple=true' if you want response multiple unified response
			if ( (isset($request_options->multiple) && $request_options->multiple===true) || strpos($request_options->term_id, ',')!==false ) {

				$ar_response = [];
				$terms = explode(',', $request_options->term_id);
				foreach ($terms as $term_id) {

					$term_id = trim($term_id);

					if (empty($term_id)) {
						debug_log(__METHOD__." Ignored empty term_id in ".to_string($terms), logger::ERROR);
						continue;
					}

					$request_options_clone = clone $request_options;
						$request_options_clone->term_id		= $term_id;
						$request_options_clone->multiple	= false; // avoid infinite loop

					$current_response = self::get_thesaurus_children($request_options_clone);
					$ar_response[] = (object)[
						'ter_id'	=> $term_id,
						'result'	=> $current_response->result,
						'total'		=> $current_response->total
					];
				}

				$response = new stdClass();
					$response->result 	= $ar_response;
					$response->msg 		= 'Ok. Request done ['.__METHOD__.']';
					$response->total 	= null;

				return $response;
			}

			$options = new stdClass();
				$options->term_id				= null;
				$options->recursive				= false;
				$options->lang					= WEB_CURRENT_LANG_CODE;
				$options->ar_fields				= array('*');
				$options->only_descriptors		= true;
				$options->remove_restricted		= true;
				$options->remove_unused_terms	= false; // If true, exclude of results the children without indexations and children
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			$section_tipo = explode('_', $options->term_id)[0];

			if (empty($section_tipo) || empty($table_thesaurus_map[$section_tipo])) {
				$response = new stdClass();
					$response->result	= [];
					$response->msg		= 'Error. Invalid section tipo ('.to_string($section_tipo).') or not defined in table_thesaurus_map (see API server config) ';
					$response->total	= 0;

				return $response;
			}

			$table					= $table_thesaurus_map[$section_tipo];
			$lang					= $options->lang;
			$recursive				= $options->recursive;
			$ar_fields				= $options->ar_fields;
			$only_descriptors		= $options->only_descriptors;
			$remove_restricted		= $options->remove_restricted;
			$remove_unused_terms	= $options->remove_unused_terms;


			if (!is_array($ar_fields)) {
				$ar_fields = explode(',',$ar_fields);
			}

			# Force ar_fields term_id
			if (!in_array('*',$ar_fields) && !in_array('term_id',$ar_fields)) {
				array_unshift($ar_fields, 'term_id');
			}


			// get_items. Recursion is optional
			if (!function_exists('get_items')) {
			function get_items($current_term_id, $table, $lang, $ar_fields, $recursive, $only_descriptors, $remove_restricted, $remove_unused_terms) {

				# Compatibility with old parent data (single)
				$term_filter = '';
				if (strpos($current_term_id,'["')===false) {
					$term_filter .= '(parent = \'["'.$current_term_id.'"]\' OR parent = \''.$current_term_id.'\')';
				}else{
					$term_filter .= '(parent = \''.$current_term_id.'\' OR parent = \''.substr($current_term_id, 2, strlen($current_term_id)-2).'\')';
				}

				# only_descriptors
				if ($only_descriptors===true) {
					$term_filter .= " AND descriptor = 'yes' ";
				}

				# remove_restricted
				if ($remove_restricted===true) {
					$ar_restricted_terms = json_decode(AR_RESTRICTED_TERMS);
					if (!empty($ar_restricted_terms)) {
						$ar=array();
						foreach ((array)$ar_restricted_terms as $key => $restricted_term) {
							$ar[] = "term_id != '{$restricted_term}'";
						}
						$term_filter .= ' AND (' . implode(' AND ', $ar) . ') ';
					}
				}

				$field_indexation = defined('FIELD_INDEX') ? FIELD_INDEX : 'indexation';

				# Remove unused terms
				if ($remove_unused_terms===true) {
					$term_filter .= ' AND ('.$field_indexation.' IS NOT NULL OR children IS NOT NULL)';
				}
				#error_log($term_filter);


				$sd_options = new stdClass();
					$sd_options->table		= $table;
					$sd_options->ar_fields	= $ar_fields;
					$sd_options->sql_filter	= $term_filter; //"parent = '".$term_id_search."' ";
					$sd_options->lang		= $lang;
					$sd_options->limit		= 0;

				$search_data = (object)web_data::get_rows_data( $sd_options );
					#debug_log(__METHOD__." search data ".to_string($search_data), logger::DEBUG);

				$ar_data = ($search_data->result!==false) ? (array)$search_data->result : [];

				if ($recursive===true && !empty($search_data->result)) {
					foreach($ar_data as $current_row) {
						#dump($current_row, ' current_row ++ '.to_string());
						$items = get_items($current_row["term_id"], $table, $lang, $ar_fields, $recursive, $only_descriptors, $remove_restricted, $remove_unused_terms);
						#dump($items, ' items ++ '.to_string($current_row["term_id"]));
						$ar_data = array_merge($ar_data, $items);
						#debug_log(__METHOD__." items RECURSIVE ++ ".to_string($items), logger::DEBUG);
					}
				}


				return (array)$ar_data;
			}//end get_items
			}
			$ar_children = get_items($options->term_id, $table, $lang, $ar_fields, $recursive, $only_descriptors, $remove_restricted, $remove_unused_terms);
				#dump($ar_children, ' ar_children ++ '.to_string());

			$response = new stdClass();
				$response->result 	= $ar_children;
				$response->msg 		= 'Ok. Request done ['.__METHOD__.']';
				$response->total 	= count($ar_children);

			return $response;
		}//end get_thesaurus_children



		/**
		* GET_THESAURUS_PARENTS
		* Resolves the given term parents
		* @param object $request_options
		* @return object $response
		*/
		public static function get_thesaurus_parents( $request_options ) {
			global $table_thesaurus_map; // From server api config

			$start_time = microtime(1);

			$options = new stdClass();
				$options->term_id  		= null;
				$options->recursive 	= true;
				$options->lang 		   	= WEB_CURRENT_LANG_CODE;
				$options->ar_fields 	= array('*');
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			$ar_parts 		= explode('_', $options->term_id);
			$section_tipo 	= $ar_parts [0];
			#$section_id 	= $ar_parts [1];
			$table 			= $table_thesaurus_map[$section_tipo];
			$lang 			= $options->lang;
			$recursive 		= $options->recursive;
			$ar_fields 		= $options->ar_fields;

			// term_id is mandatory
				if (is_string($ar_fields)) {
					$ar_fields = explode(',', $ar_fields);
					$ar_fields = array_map(function($item){
						return trim($item);
					}, $ar_fields);
				}
				if (!in_array('term_id', (array)$ar_fields)) {
					$ar_fields[] = 'term_id';
				}

			// get_items. Recursion is optional
			// if (!function_exists('get_items'))
			function get_items($current_term_id, $table, $lang, $ar_fields, $recursive) {

				$ar_parts 		= explode('_', $current_term_id);
				$section_tipo 	= $ar_parts [0];
				$section_id 	= $ar_parts [1];

				$dedalo_relation_type_children_tipo = defined('DEDALO_RELATION_TYPE_CHILDREN_TIPO') ? DEDALO_RELATION_TYPE_CHILDREN_TIPO : 'dd48';

				$sd_options = new stdClass();
					$sd_options->table 	 	= $table;
					$sd_options->ar_fields  = $ar_fields;
					$sd_options->sql_filter = "children LIKE '%\"type\":\"".$dedalo_relation_type_children_tipo."\",\"section_id\":\"".$section_id ."\",\"section_tipo\":\"".$section_tipo."\"%' ";
					#$sd_options->sql_filter = "parent = '".$current_term_id."' ";
					#$sd_options->order 	 = "section_id ASC";
					$sd_options->lang 	 	= $lang;

				$search_data	= (object)web_data::get_rows_data( $sd_options );
					#dump($search_data, ' search_data ++ '.to_string($sd_options));

				$ar_data = (array)$search_data->result;

				if ($recursive===true && !empty($search_data->result)) {
					foreach ($search_data->result as $current_row) {
						$ar_data = array_merge($ar_data, get_items($current_row["term_id"], $table, $lang, $ar_fields, $recursive));
					}
				}

				return (array)$ar_data;
			}//end get_items
			$ar_parent = get_items($options->term_id, $table, $lang, $ar_fields, $recursive);
				#dump($ar_parent, ' ar_parent ++ '.to_string());


			$response = new stdClass();
				$response->result 	= $ar_parent;
				$response->msg 		= 'Ok. Request done ['.__METHOD__.']';
				if(SHOW_DEBUG===true) {
					$response->debug['time'] = round(microtime(1)-$start_time,3);
				}


			return $response;
		}//end get_thesaurus_parents



	/* FREE SEARCH
	----------------------------------------------------------------------- */


		/**
		* GET_FREE_SEARCH
		* Note: Search string is expected utf-8 rawurlencoded — URL-encode according to RFC 3986
		* @return object $response
		*/
		public static function get_free_search( $request_options ) {

			$response = new stdClass();
				$response->result = false;
				$response->msg 	  = 'Error. Request free_search failed';

			$options = new stdClass();
				$options->q 				= null;
				$options->search_mode 		= 'full_text_search';
				$options->rows_per_page 	= 10;
				$options->page_number 		= 1;
				$options->offset 			= 0;
				$options->appearances_limit = 1;
				$options->match_select 		= false; // Selects specific match inside results. Default = false . Optional
				$options->count 			= true;
				$options->image_type 	 	= 'posterframe';
				$options->list_fragment 	= true;
				$options->video_fragment 	= false;
				$options->fragment_terms 	= false;
				$options->filter 			= false;
				$options->lang 				= WEB_CURRENT_LANG_CODE;
				$options->is_literal 		= false;
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}


			# Search string is expected rawurlencoded — URL-encode according to RFC 3986
			#$options->q = addslashes( rawurldecode($options->q) );
			$options->q = web_data::get_db_connection()->real_escape_string($options->q);

			// is_literal active case. Remove possible quotes added and force add new ones
				if ($options->is_literal===true) {
					$clean_q = trim($options->q, '\"');
					$options->q = '"'.$clean_q.'"';
				}

			# Offset
			if ($options->page_number>1) {
				$options->offset = ($options->page_number-1) * $options->rows_per_page;
			}

			# TABLE FIELDS
			# $ar_fields = web_data::get_table_fields(TABLE_AUDIOVISUAL);
			$ar_fields = array("section_id", FIELD_VIDEO, FIELD_TRANSCRIPTION);

			#
			# AUDIOVISUAL RECORDS
			switch ($options->search_mode) {
				case 'full_text_search':
				default:
					$search_options = new stdClass();
						$search_options->table 		= (string)TABLE_AUDIOVISUAL;
						$search_options->ar_fields 	= array_merge(
													array("MATCH (".FIELD_TRANSCRIPTION.") AGAINST ('$options->q') AS relevance "), $ar_fields );
						// $search_options->ar_fields 	= $ar_fields;
						$search_options->sql_filter = 	 " MATCH (".FIELD_TRANSCRIPTION.") AGAINST ('$options->q' IN BOOLEAN MODE) "; // AND lang = '".WEB_CURRENT_LANG_CODE."'
						if ($options->filter!==false) {
							$search_options->sql_filter .= " AND (" .$options->filter .")";
						}
						$search_options->lang		= $options->lang;
						$search_options->order		= "relevance DESC";
						$search_options->limit		= $options->rows_per_page;
						$search_options->offset		= $options->offset;
						$search_options->count		= $options->count;
						$search_options->is_literal	= $options->is_literal; // if literal is true, ar_fields allow spaces and double quotes (needed for 'MATCH (rsc36) AGAINST..')


					$rows_data	= (object)web_data::get_rows_data( $search_options );
						#dump($rows_data->result, ' $rows_data ++ '.to_string());
						#dump($search_options, ' $search_options ++ '.to_string()); die();
					break;
			}

			if($rows_data->result===false) {
				$response->result = false;
				$response->msg 	  = 'Error. Request free_search failed. '.$rows_data->msg;
				return $response;
			}

			$ar_free_nodes	= array();
			$skipped		= 0; // rows discarded as false positives (match only inside tags)
			foreach ($rows_data->result as $key => $obj_value) {

				$av_section_id = $obj_value['section_id'];

				$fn_options = new stdClass();
					$fn_options->q 				  	= $options->q;
					$fn_options->appearances_limit 	= $options->appearances_limit;
					$fn_options->match_select 		= $options->match_select;
					$fn_options->image_type 	  	= $options->image_type;
					$fn_options->video_fragment 	= $options->video_fragment;
					$fn_options->list_fragment 		= $options->list_fragment;
					$fn_options->fragment_terms 	= $options->fragment_terms;
					$fn_options->lang 				= $options->lang;
					foreach ($ar_fields as $current_field) {
						if($current_field==='section_id') continue;
						$fn_options->$current_field = $obj_value[$current_field];
					}
					#dump($fn_options, ' fn_options ++ '.to_string());
				$free_node = new free_node( $av_section_id, $fn_options );
				$free_node->load_data(); # Force load data

				# Clean data
				$FIELD_TRANSCRIPTION = FIELD_TRANSCRIPTION;
				unset($free_node->{$FIELD_TRANSCRIPTION});

				# Skip false positives: SQL FULLTEXT matched only inside tags (masked in fragments search)
				if (empty($free_node->fragments)) {
					$skipped++;
					continue;
				}

				if(SHOW_DEBUG===true) {
					#dump($free_node, ' free_node ++ '.to_string());;
				}

				$ar_free_nodes[] = $free_node;
			}//end foreach ($rows_data->result as $key => $obj_value)

			# Add vars for pagination
			$response->page_number 	 = $options->page_number;
			$response->rows_per_page = $options->rows_per_page;
			// total: SQL FULLTEXT count minus rows skipped in this page, to keep coherence with result
			$response->total 		 = max(0, (int)$rows_data->total - $skipped);
			$response->skipped 		 = $skipped;

			$response->result 	= $ar_free_nodes;
			$response->msg 		= 'Ok. Request free_search done successfully';


			return $response;
		}//end get_free_search



	/* FULL NODE
	----------------------------------------------------------------------- */



		/**
		* GET_FULL_REEL
		* Get full reel data. Complete transcription and no tc cut
		* Used when you need show full interview (mode full)
		* @return object $response
		*/
		public static function get_full_reel( $request_options ) {

			$options = new stdClass();
				$options->av_section_id		= false;
				$options->lang 				= WEB_CURRENT_LANG_CODE;
				$options->image_type 		= 'posterframe';
				$options->terms 			= false;
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			$response = new stdClass();
				$response->result = false;
				$response->msg 	  = 'Error. Request full_reel failed';

			$full_node = new full_node( $options->av_section_id, $fn_options=$options );
			$full_node->load_data(); # Froce to load data
				#dump($full_node, ' full_node ++ '.to_string());
			# Clean data
			$FIELD_TRANSCRIPTION = FIELD_TRANSCRIPTION;
			unset($full_node->{$FIELD_TRANSCRIPTION});

			$response->result = $full_node;
			$response->msg 	  = 'Ok. Request full_reel done successfully';


			return $response;
		}//end get_full_reel



		/**
		* GET_FULL_INTERVIEW
		* Get full interview reels data. Complete transcription and no tc cut
		* Used when you need show full interview (mode full)
		* @return object $response
		*/
		public static function get_full_interview( $request_options ) {

			$options = new stdClass();
				$options->section_id	= false;
				$options->lang			= WEB_CURRENT_LANG_CODE;
				$options->image_type	= 'posterframe';
				$options->terms			= false;
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			$response = new stdClass();
				$response->result	= false;
				$response->msg		= 'Error. Request full_interview failed';


			// resolve interview tapes (audiovisual)
				$sd_options = new stdClass();
					$sd_options->table		= TABLE_INTERVIEW;
					$sd_options->ar_fields	= ['section_id',FIELD_AUDIOVISUAL];
					$sd_options->sql_filter	= 'section_id='.(int)$options->section_id;
					$sd_options->lang		= $options->lang;
					$sd_options->limit		= 1;

				$search_data	= (object)web_data::get_rows_data( $sd_options );
				$row			= (object)reset($search_data->result);
				$field_name		= FIELD_AUDIOVISUAL;
				$ar_audiovisual	= isset($row->{$field_name})
					? json_decode($row->{$field_name})
					: [];

				$ar_result = [];
				foreach ($ar_audiovisual as $section_id) {

					$full_reel_options = clone $options;
					$full_reel_options->av_section_id = (int)$section_id;

					$current_response	= web_data::get_full_reel($full_reel_options);
					$ar_result[]		= $current_response->result;
				}

			$response->result	= $ar_result;
			$response->msg		= 'Ok. Request full_interview done successfully';


			return $response;
		}//end get_full_interview



	/* GEOLOCATION
	----------------------------------------------------------------------- */



		/**
		* GET_GEOLOCATION_DATA -> moved to class.diffusion_sql.php
		* @return
		*/
		public static function get_geolocation_data( $request_options ) {

			// Test data
			// $request_options->raw_text = '[geo-n-1--data:{'type':'FeatureCollection','features':[{'type':'Feature','properties':{},'geometry':{'type':'Point','coordinates':[2.097785,41.393268]}}]}:data]Bateria antiaèria de Sant Pere Màrtir. Esplugues de Llobregat&nbsp;[geo-n-2--data:{'type':'FeatureCollection','features':[{'type':'Feature','properties':{},'geometry':{'type':'Point','coordinates':[2.10389792919159,41.393728914379295]}}]}:data]&nbsp;Texto dos';
			// $request_options->raw_text = '[geo-n-1--data:{\'type\':\'FeatureCollection\',\'features\':[{\'type\':\'Feature\',\'properties\':{},\'geometry\':{\'type\':\'Point\',\'coordinates\':[2.097785,41.393268]}}]}:data]Bateria antiaèria de Sant Pere Màrtir. Esplugues de Llobregat&nbsp;[geo-n-2--data:{\'type\':\'FeatureCollection\',\'features\':[{\'type\':\'Feature\',\'properties\':{},\'geometry\':{\'type\':\'Point\',\'coordinates\':[2.10389792919159,41.393728914379295]}}]}:data]&nbsp;Texto dos';
			$request_options->raw_text = 'Hola que tal [geo-n-1--data:{\'type\':\'FeatureCollection\',\'features\':[{\'type\':\'Feature\',\'properties\':{},\'geometry\':{\'type\':\'Point\',\'coordinates\':[2.097785,41.393268]}}]}:data]Bateria antiaèria de Sant Pere Màrtir. Esplugues de Llobregat&nbsp;[geo-n-2--data:{\'type\':\'FeatureCollection\',\'features\':[{\'type\':\'Feature\',\'properties\':{},\'geometry\':{\'type\':\'Point\',\'coordinates\':[2.10389792919159,41.393728914379295]}}]}:data] Texto dos';

			$options = new stdClass();
				$options->raw_text			= false;
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			$response = new stdClass();
				$response->result = false;
				$response->msg 	  = 'Error. Request get_geolocation_data failed';

			// $pattern = TR::get_mark_pattern('geo',false);
			// $result  = free_node::pregMatchCapture($matchAll=true, $pattern, $options->raw_text, $offset=0);

			// split by pattern
			$pattern_geo_full = TR::get_mark_pattern('geo_full',$standalone=true);
			$result 		  = preg_split($pattern_geo_full, $options->raw_text, -1, PREG_SPLIT_NO_EMPTY | PREG_SPLIT_DELIM_CAPTURE);

			// sample result
			// [0] => [geo-n-1--data:{'type':'FeatureCollection','features':[{'type':'Feature','properties':{},'geometry':{'type':'Point','coordinates':[2.097785,41.393268]}}]}:data]
			//    [1] => Bateria antiaèria de Sant Pere Màrtir. Esplugues de Llobregat&nbsp;
			//    [2] => [geo-n-2--data:{'type':'FeatureCollection','features':[{'type':'Feature','properties':{},'geometry':{'type':'Point','coordinates':[2.10389792919159,41.393728914379295]}}]}:data]
			//    [3] => &nbsp;Texto dos

		    $ar_elements = array();
		    $pattern_geo = TR::get_mark_pattern('geo',$standalone=true);
		    $key_tag_id  = 4;
		    $key_data    = 7;
		    foreach ((array)$result as $key => $value) {
		    	if (strpos($value,'[geo-')===0) {
		    		$tag_string  = $value;
		    		$next_row_id = (int)($key+1);
		    		$text 		 = '';
		    		if (isset($result[$next_row_id]) && strpos($result[$next_row_id],'[geo-')!==0) {
		    			$text = trim($result[$next_row_id]);
		    		}

		    		preg_match_all($pattern_geo, $value, $matches);

		    		$layer_id = (int)$matches[$key_tag_id][0];
		    		$geo_data = $matches[$key_data][0] ?? null;
		    		if(!empty($geo_data)) {
		    			$geo_data = str_replace('\'', '"', $geo_data);
		    			$geo_data = json_decode($geo_data);
		    		}

		    		$layer_data = $geo_data;

		    		$element = new stdClass();
		    			$element->layer_id 		= $layer_id;
		    			$element->text 			= $text;
		    			$element->layer_data	= $layer_data;

		    		$ar_elements[] = $element;
		    	}
		    }//end foreach ((array)$result as $key => $value)

			dump($result, ' result ++ '.to_string($pattern_geo));
			dump($ar_elements, ' ar_elements ++ '.to_string());

			$response->result = $ar_elements;
			$response->msg 	  = 'Ok. Request done. get_geolocation_data';

			return $response;
		}//end get_geolocation_data



	/* GLOBAL SEARCH
	----------------------------------------------------------------------- */


		/**
		* GET_GLOBAL_SEARCH
		* Note: Search string is expected utf-8 rawurlencoded — URL-encode according to RFC 3986
		* @return object $response
		*/
		public static function get_global_search( $request_options ) {

			$response = new stdClass();
				$response->result = false;
				$response->msg 	  = 'Error. Request free_search failed';

			$options = new stdClass();
				$options->q 				= null;
				$options->search_modifier 	= 'IN BOOLEAN MODE';
				$options->sql_filter 		= false;
				$options->lang 				= WEB_CURRENT_LANG_CODE;
				$options->rows_per_page 	= 10;
				$options->page_number 		= 1;
				$options->offset 			= 0;
				$options->count 			= true;
				$options->ar_fields 		= array('section_id','list_data','link');
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}


			# Search string is expected rawurlencoded — URL-encode according to RFC 3986
			# q scape
			if ($options->q!==false) {
				$options->q = web_data::get_db_connection()->real_escape_string($options->q);
			}

			# Offset
			if ($options->page_number>1) {
				$options->offset = ($options->page_number-1) * $options->rows_per_page;
			}

			$global_search_table = defined('TABLE_GLOBAL_SEARCH') ? TABLE_GLOBAL_SEARCH : 'global_search';
			$field_full_data 	 = defined('FIELD_FULL_DATA') ? FIELD_FULL_DATA : 'full_data';

			#
			# GLOBAL SEARCH RECORDS
			$search_options = new stdClass();
				$search_options->table 		= $global_search_table;
				$search_options->ar_fields 	= $options->ar_fields;
				# Filter
				$search_options->sql_filter = '';
				# q
				if ($options->q!==false) {
					# Add field
					$field_fts = "MATCH (".$field_full_data.") AGAINST ('$options->q') AS relevance ";
					array_unshift($search_options->ar_fields, $field_fts);
					# Add filter
					$search_options->sql_filter .= 'MATCH ('.$field_full_data.') AGAINST (\''.$options->q.'\' '.$options->search_modifier.')';
				}
				# sql_filter
				if ($options->sql_filter!==false) {
					if (!empty($options->q)) {
						$search_options->sql_filter .= ' AND (' . $options->sql_filter .')';
					}else{
						$search_options->sql_filter .= $options->sql_filter;
					}
				}
				$search_options->lang 		= $options->lang;
				$search_options->order 		= "relevance DESC";
				$search_options->limit 		= $options->rows_per_page;
				$search_options->offset 	= $options->offset;
				$search_options->count 		= $options->count;

			$rows_data = (object)web_data::get_rows_data( $search_options );
				#dump($rows_data->result, ' $rows_data ++ '.to_string());
				#dump($search_options, ' $search_options ++ '.to_string()); die();

			if($rows_data->result===false) {
				$response->result = false;
				$response->msg 	  = 'Error. Request global_search failed. '.$rows_data->msg;
				return $response;
			}

			# Add vars for pagination
			$response->page_number 	 = $options->page_number;
			$response->rows_per_page = $options->rows_per_page;
			$response->total 		 = $rows_data->total;

			$response->result 		 = $rows_data->result;
			$response->msg 			 = 'OK. Request global_search done successfully';


			return $response;
		}//end get_global_search



		/**
		* GET_GLOBAL_SEARCH_JSON
		* Note: Search string is expected utf-8 rawurlencoded — URL-encode according to RFC 3986
		* @return object $response
		*/
		public static function get_global_search_json( $request_options ) {
			$start_time = microtime(1);

			$response = new stdClass();
				$response->results 	= false;
				#$response->msg 	= 'Error. Request get_global_search_json failed';

			$options = new stdClass();
				$options->json_search = null;
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			// Example
				// {
				//     "database": "sra",
				//     "lang": "ca",
				//     "query": "batalla del ebro",
				//     "filters": {
				//    	 "birth_place": "es1_2352",
				//    	 "dead_at_prison": false,
				//    	 "end_date": 376790400,
				//    	 "exile_place": "es1_967"
				//    	 "municipality": "on1_5624"
				//    	 "name_surname": "Rubianes",
				//    	 "neighborhood": "es1_967",
				//    	 "prison_municipality": "Barcelona",
				//    	 "prison": "Presó Convent de les Adoratrius de Girona",
				//    	 "project": 34,
				//    	 "pub_author": "Julio Verne",
				//    	 "pub_editor": "Joan Porcel",
				//    	 "pub_year": 1985,
				//    	 "region": "on1_5624"
				//    	 "residence_place": "es1_2352",
				//    	 "start_date": 376790400,
				//    	 "theme": "Espais de la Guerra Civil",
				//    	 "thesaurus": ["id_1", "id_2", "id_3"],
				//    	 "title": "Títol específic",
				//    	 "typology": "Llibre",
				// 		 "data_mod": "2015-12-22",
				//		 "death_context": 1
				//     },
				//     "pagination":{
				//    	 "limit": 10,
				//    	 "offset": 0
				//     },
				//     "sort":{
				//    	 "name": "date",
				//    	 "direction": "asc",
				//     }
				// }

			// check options json_search is valid json object
				if(!$json_data = json_decode($options->json_search)){
					debug_log(__METHOD__." Error on make global search. Invalid options  ".to_string($options->json_search), logger::WARNING);
					return $response;
				}

			// q . From property 'query'
				$q = isset($json_data->query) ? $json_data->query : null;

			// lang code convert from tld2 to dedalo lang
				switch ($json_data->lang) {
					case 'ca': $lang = 'lg-cat'; break;
					case 'es': $lang = 'lg-spa'; break;
					case 'en': $lang = 'lg-eng'; break;
					case 'fr': $lang = 'lg-fra'; break;
					default: $lang = null;
				}

			// pagination properties
				$rows_per_page  = isset($json_data->pagination->limit) ? $json_data->pagination->limit : 10;
				$offset 		= isset($json_data->pagination->offset) ? $json_data->pagination->offset : 0;

			#
			# ORDER
				$order = '';
				if (!empty($json_data->sort) && !empty($json_data->sort->name) && !empty($json_data->sort->direction)) {
					if ($json_data->sort->name==='name') {
						#$json_data->sort->name = 'full_data';
						#$json_data->sort->name = 'name_surname'; // Changed 18-03-2018 !!
						$json_data->sort->name = 'sort'; // Changed 16-11-2018 !!
					}
					elseif ($json_data->sort->name==='date') {
						$json_data->sort->name = 'start_date';
					}
					elseif ($json_data->sort->name==='data_mod') {
						$json_data->sort->name = 'data_mod';
					}
					$order = $json_data->sort->name.' '.strtoupper($json_data->sort->direction);
				}

			$options->q 				= $q;
			$options->search_modifier 	= 'IN BOOLEAN MODE';
			$options->sql_filter 		= false;
			$options->lang 				= $lang;
			$options->rows_per_page 	= $rows_per_page;
			$options->page_number 		= 1;
			$options->offset 			= $offset;
			$options->count 			= true;
			$options->order 			= $order;
			#$options->ar_fields 		= array('id','section_id','list_data','link');

			# Search string is expected rawurlencoded — URL-encode according to RFC 3986
			# q escape
				if (!empty($options->q)) {
					$options->q = web_data::get_db_connection()->real_escape_string($options->q);
				}
				function escape_string($string) {
					$result = web_data::get_db_connection()->real_escape_string($string);
					return $result;
				}

			#
			# FILTER
				$ar_filter = [];
				# database (table)
				if (!empty($json_data->database)) {
					$ar_filter[] = "`table` = '".strtolower($json_data->database)."'";
				}
				# birth_place
				if (!empty($json_data->filters->birth_place)) {
					$ar_filter[] = "birth_place LIKE '%\"".escape_string($json_data->filters->birth_place)."\"%'";
				}
				# dead_at_prison
				if (!empty($json_data->filters->dead_at_prison) && is_bool($json_data->filters->dead_at_prison)) {
					if ($json_data->filters->dead_at_prison===true) {
						$ar_filter[] = "dead_at_prison = 1 ";
					}else if ($json_data->filters->dead_at_prison===false) {
						$ar_filter[] = "dead_at_prison IS NULL ";
					}
				}
				# end_date . data format timestamp UNIX
				if (!empty($json_data->filters->end_date)) {
					#$ar_filter[] = "end_date = '".$json_data->filters->end_date."'";
					if (is_array($json_data->filters->end_date)) {
						$in  = isset($json_data->filters->end_date[0]) ? (int)$json_data->filters->end_date[0] : false;
						$out = isset($json_data->filters->end_date[1]) ? (int)$json_data->filters->end_date[1] : false;
						if ($in!==false && $out!==false) {
							$end_date_filter = '(end_date >= '.$in.' AND end_date <= '.$out.')';
						}elseif ($in!==false) {
							$end_date_filter = 'end_date = '.$in;
						}
					}else{
						$end_date_filter = 'end_date = '.(int)$json_data->filters->end_date;
					}
					if (!empty($end_date_filter)) {
						$ar_filter[] = $end_date_filter;
					}
				}
				# exile_place . like es1_967
				if (!empty($json_data->filters->exile_place)) {
					$ar_filter[] = "exile_place LIKE '%\"".escape_string($json_data->filters->exile_place)."\"%'";
				}
				# municipality . like es1_967
				if (!empty($json_data->filters->municipality)) {
					$ar_filter[] = "municipality LIKE '%\"".escape_string($json_data->filters->municipality)."\"%'";
				}
				# name_surname . like Rubianes
				if (!empty($json_data->filters->name_surname)) {
					#$ar_filter[] = "name_surname LIKE '%\"".$json_data->filters->name_surname."\"%'";
					$ar_filter[] = "name_surname LIKE '%".escape_string($json_data->filters->name_surname)."%'"; // Changed 18-03-2018 !!
				}
				# neighborhood . like es1_967
				if (!empty($json_data->filters->neighborhood)) {
					$ar_filter[] = "neighborhood LIKE '%\"".escape_string($json_data->filters->neighborhood)."\"%'";
				}
				# prison_municipality . like Barcelona
				if (!empty($json_data->filters->prison_municipality)) {
					$ar_filter[] = "prison_municipality LIKE '%".escape_string($json_data->filters->prison_municipality)."%'";
				}
				# prison . like ["582","3","4","12446"] (portal to table)
				if (!empty($json_data->filters->prison)) {
					$ar_filter[] = "prison LIKE '%\"".escape_string($json_data->filters->prison)."\"%'";
				}
				# project. like 68
				if (!empty($json_data->filters->project)) {
					$ar_filter[] = "project LIKE '%\"".escape_string($json_data->filters->project)."\"%'";
				}
				# fons_code. like 68
				if (!empty($json_data->filters->fons_code)) {
					if (is_array($json_data->filters->fons_code)) {
						$ar_fons_code = $json_data->filters->fons_code;
						$ar_fons_code_query = [];
						foreach ((array)$ar_fons_code as $key => $value) {
							$ar_fons_code_query[] = "`fons_code` LIKE '%\"".escape_string($value)."\"%'";
						}
						if (!empty($ar_fons_code_query)) {
							$current_filter_fons_code = '('.implode(' OR ', $ar_fons_code_query).')';
							#dump($current_filter_fons_code, ' current_filter_fons_code ++ '.to_string($current_filter_fons_code));
							$ar_filter[] 	= $current_filter_fons_code;
						}
					}else{
						$ar_filter[] = "fons_code LIKE '%\"".escape_string($json_data->filters->fons_code)."\"%'";
					}
				}
				# pub_author . like Joan Porcel
				if (!empty($json_data->filters->pub_author)) {
					$ar_filter[] = "pub_author LIKE '%".escape_string($json_data->filters->pub_author)."%'";
				}
				# pub_editor . like Joan Porcel
				if (!empty($json_data->filters->pub_editor)) {
					$ar_filter[] = "pub_editor LIKE '%".escape_string($json_data->filters->pub_editor)."%'";
				}
				# pub_year . like 1920
				if (!empty($json_data->filters->pub_year)) {
					$ar_filter[] = "pub_year = ".$json_data->filters->pub_year;
				}
				# region . like
				if (!empty($json_data->filters->region)) {
					$ar_filter[] = "region LIKE '%\"".escape_string($json_data->filters->region)."\"%'";
				}
				# residence_place
				if (!empty($json_data->filters->residence_place)) {
					$ar_filter[] = "residence_place LIKE '%".escape_string($json_data->filters->residence_place)."%'";
				}
				# start_date . like 376790400 OR [376790400,396790400]
				if (!empty($json_data->filters->start_date)) {
					#$ar_filter[] = "start_date = ".$json_data->filters->start_date;
					#$ar_filter[] = "start_date = '".$json_data->filters->start_date."'";
					if (is_array($json_data->filters->start_date)) {
						$in  = isset($json_data->filters->start_date[0]) ? (int)$json_data->filters->start_date[0] : false;
						$out = isset($json_data->filters->start_date[1]) ? (int)$json_data->filters->start_date[1] : false;
						if ($in!==false && $out!==false) {
							$start_date_filter = '(start_date >= '.$in.' AND start_date <= '.$out.')';
						}elseif ($in!==false) {
							$start_date_filter = 'start_date = '.$in;
						}
					}else{
						$start_date_filter = 'start_date = '.(int)$json_data->filters->start_date;
					}
					if (!empty($start_date_filter)) {
						$ar_filter[] = $start_date_filter;
					}
				}
				# theme . varchar like '3'
				if (!empty($json_data->filters->theme)) {
					$ar_filter[] = "theme = '".escape_string($json_data->filters->theme)."'";
				}
				# thesaurus . like [“es1_2352”, “es1_967”]
				if (!empty($json_data->filters->thesaurus)) {
					$ar_thesaurus = $json_data->filters->thesaurus;
						#dump($ar_thesaurus, ' ar_thesaurus ++ '.to_string());
					$ar_term = [];
					foreach ((array)$ar_thesaurus as $key => $value) {
						$ar_term[] = "`thesaurus` LIKE '%\"".escape_string($value)."\"%'";
					}
					#dump($ar_term, ' ar_term ++ '.to_string());
					if (!empty($ar_term)) {
						$current_filter_thesaurus = '('.implode(' AND ', $ar_term).')';
						#dump($current_filter_thesaurus, ' current_filter_thesaurus ++ '.to_string($current_filter_thesaurus));
						$ar_filter[] 	= $current_filter_thesaurus;
					}
				}
				# title . like Title de la Guerra Civil
				if (!empty($json_data->filters->title)) {
					$ar_filter[] = "`title` LIKE '%".escape_string($json_data->filters->title)."%'";
				}
				# typology
				if (!empty($json_data->filters->typology)) {
					$ar_filter[] = "`typology` = '".$json_data->filters->typology."'";
				}
				# data_mod
				if (!empty($json_data->filters->data_mod)) {

					preg_match('/(>=|<=|>|<)(.*)/', $json_data->filters->data_mod, $match);

					if (isset($match[1]) && isset($match[2])) {

						$operator 	= $match[1];
						$date_value = $match[2];

						$ar_filter[] = '`data_mod` '.$operator.' \''.$date_value.'\'';
					}else{
						$ar_filter[] = '`data_mod` REGEXP \''.$json_data->filters->data_mod.'\'';
					}
				}
				# situation . like ["1","5"] - operator: OR
				if (!empty($json_data->filters->situation)) {
					$ar_situation = $json_data->filters->situation;
					$ar_term = [];
					foreach ((array)$ar_situation as $key => $value) {
						$ar_term[] = "`situation` LIKE '%\"".escape_string($value)."\"%'";
						// $ar_term[] = "`situation` = '[\"".escape_string($value)."\"]'";
					}
					if (!empty($ar_term)) {
						$current_filter_situation = '('.implode(' OR ', $ar_term).')';
						$ar_filter[] 	= $current_filter_situation;
					}
				}
				# situation_place . like ["es1_2352","es1_2359"] - operator: AND
				if (!empty($json_data->filters->situation_place)) {
					$ar_situation_place = $json_data->filters->situation_place;
					$ar_term = [];
					foreach ((array)$ar_situation_place as $key => $value) {
						$ar_term[] = "`situation_place` LIKE '%\"".escape_string($value)."\"%'";
					}
					if (!empty($ar_term)) {
						$current_filter_situation_place = '('.implode(' AND ', $ar_term).')';
						$ar_filter[] 	= $current_filter_situation_place;
					}
				}
				# nazi_camp . like ["es1_2352","es1_2359"] - operator: AND
				if (!empty($json_data->filters->nazi_camp)) {
					$ar_nazi_camp = $json_data->filters->nazi_camp;
					$ar_term = [];
					foreach ((array)$ar_nazi_camp as $key => $value) {
						$ar_term[] = "`nazi_camp` LIKE '%\"".escape_string($value)."\"%'";
					}
					if (!empty($ar_term)) {
						$current_filter_nazi_camp = '('.implode(' AND ', $ar_term).')';
						$ar_filter[] 	= $current_filter_nazi_camp;
					}
				}
				# nazi_sub_camp . like ["es1_2352","es1_2359"] - operator: AND
				if (!empty($json_data->filters->nazi_sub_camp)) {
					$ar_nazi_sub_camp = $json_data->filters->nazi_sub_camp;
					$ar_term = [];
					foreach ((array)$ar_nazi_sub_camp as $key => $value) {
						$ar_term[] = "`nazi_sub_camp` LIKE '%\"".escape_string($value)."\"%'";
					}
					if (!empty($ar_term)) {
						$current_filter_nazi_sub_camp = '('.implode(' AND ', $ar_term).')';
						$ar_filter[] 	= $current_filter_nazi_sub_camp;
					}
				}
				# prisoner_number - operator: AND
				if (!empty($json_data->filters->prisoner_number)) {
					$ar_prisoner_number = $json_data->filters->prisoner_number;
					$ar_term = [];
					foreach ((array)$ar_prisoner_number as $key => $value) {
						$ar_term[] = "`prisoner_number` LIKE '%\"".escape_string($value)."\"%'";
					}
					if (!empty($ar_term)) {
						$current_filter_prisoner_number = '('.implode(' AND ', $ar_term).')';
						$ar_filter[] 	= $current_filter_prisoner_number;
					}
				}
				# symbol_state - operator: OR
				if (!empty($json_data->filters->symbol_state)) {
					$ar_symbol_state = $json_data->filters->symbol_state;
					$ar_term = [];
					foreach ((array)$ar_symbol_state as $key => $value) {
						$ar_term[] = "`symbol_state` LIKE '%\"".escape_string($value)."\"%'";
					}
					if (!empty($ar_term)) {
						$current_filter_symbol_state = '('.implode(' OR ', $ar_term).')';
						$ar_filter[] 	= $current_filter_symbol_state;
					}
				}
				# gender . Coded gender as int like 1 . added 03-02-2021
				if (!empty($json_data->filters->gender)) {
					$ar_filter[] = 'gender = '. (int)$json_data->filters->gender;
				}

				# stolpersteine . like ["1","2"] - operator: AND
				// if (!empty($json_data->filters->stolpersteine)) {
				// 	$ar_filter[] = 'stolpersteine = '. $json_data->filters->stolpersteine;
				// }
				if (!empty($json_data->filters->stolpersteine)) {
					$ar_stolpersteine = $json_data->filters->stolpersteine;
					$ar_term = [];
					foreach ((array)$ar_stolpersteine as $key => $value) {
						if ($value==='*') {
							$ar_filter[] = '(`stolpersteine` IS NOT NULL AND `stolpersteine`!=\'\')';
							break;
						}
						$ar_term[] = "`stolpersteine` LIKE '%\"".escape_string($value)."\"%'";
						// $ar_term[] = "`stolpersteine` = '[\"".escape_string($value)."\"]'";
					}
					if (!empty($ar_term)) {
						$current_filter_stolpersteine = '('.implode(' OR ', $ar_term).')';
						$ar_filter[] 	= $current_filter_stolpersteine;
					}
				}

				# stolpersteine_date . like 376790400 OR [376790400,396790400]
				if (!empty($json_data->filters->stolpersteine_date)) {
					#$ar_filter[] = "stolpersteine_date = ".$json_data->filters->stolpersteine_date;
					#$ar_filter[] = "stolpersteine_date = '".$json_data->filters->stolpersteine_date."'";
					if (is_array($json_data->filters->stolpersteine_date)) {
						$in  = isset($json_data->filters->stolpersteine_date[0]) ? (int)$json_data->filters->stolpersteine_date[0] : false;
						$out = isset($json_data->filters->stolpersteine_date[1]) ? (int)$json_data->filters->stolpersteine_date[1] : false;
						if ($in!==false && $out!==false) {
							$stolpersteine_date_filter = '(stolpersteine_date >= '.$in.' AND stolpersteine_date <= '.$out.')';
						}elseif ($in!==false) {
							$stolpersteine_date_filter = 'stolpersteine_date = '.$in;
						}
					}else{
						$stolpersteine_date_filter = 'stolpersteine_date = '.(int)$json_data->filters->stolpersteine_date;
					}
					if (!empty($stolpersteine_date_filter)) {
						$ar_filter[] = $stolpersteine_date_filter;
					}
				}

				# stolpersteine_place . like ["es1_2352","es1_2359"] - operator: AND
				if (!empty($json_data->filters->stolpersteine_place)) {
					$ar_stolpersteine_place = $json_data->filters->stolpersteine_place;
					$ar_term = [];
					foreach ((array)$ar_stolpersteine_place as $key => $value) {
						$ar_term[] = "`stolpersteine_place` LIKE '%\"".escape_string($value)."\"%'";
					}
					if (!empty($ar_term)) {
						$current_filter_stolpersteine_place = '('.implode(' AND ', $ar_term).')';
						$ar_filter[] 	= $current_filter_stolpersteine_place;
					}
				}

				// (!) Remember to add filters too in diffusion_mysql::save_global_search_data

				// Added 09-12-2021. Is the same as above but in bulk mode
					foreach ([
						'graves_category'			=> 'int',
						'archeological_site_type'	=> 'text_array',
						'conservation'				=> 'int',
						'marked'					=> 'int',
						'dignified'					=> 'int',
						'inside_cemetery'			=> 'int',
						'grave_by_number'			=> 'int',
						'intervention_types'		=> 'text_array', // like ["1"]
						'result'					=> 'text_array', // like ["1"]
						'graves_genders'			=> 'text_array', // like ["1","2"]
						'ages'						=> 'text_array',  // like ["1","2"]
						'death_context'				=> 'text_array',  // like ["1","2"] added 10-02-2022
						'buried_type'				=> 'text_array'  // like ["1","2"] added 10-02-2022
					] as $_cname => $_ctype) {

						// skip empty columns
							if (empty($json_data->filters->{$_cname})) {
								continue;
							}

						switch ($_ctype) {
							case 'int':
								$ar_filter[] = '`'.$_cname.'` = '. (int)$json_data->filters->{$_cname};
								break;

							case 'text_array':
							default:
								// text_array like ["1","2"]
								$ar_values = $json_data->filters->{$_cname};
								$ar_term = [];
								foreach ((array)$ar_values as $element_value) {
									$ar_term[] = "`{$_cname}` LIKE '%\"".escape_string($element_value)."\"%'";
								}
								if (!empty($ar_term)) {
									$current_filter_item = '('.implode(' AND ', $ar_term).')';
									$ar_filter[] = $current_filter_item;
								}
								break;
						}
					}//end foreach


				// sql_filter add final string if not empty
					if (!empty($ar_filter)) {
						$options->sql_filter = implode(' AND ', $ar_filter);
					}


			# Offset
			#if ($options->page_number>1) {
			#	$options->offset = ($options->page_number-1) * $options->rows_per_page;
			#}

			$global_search_table = defined('TABLE_GLOBAL_SEARCH') ? TABLE_GLOBAL_SEARCH : 'global_search';
			$field_full_data 	 = defined('FIELD_FULL_DATA') ? FIELD_FULL_DATA : 'full_data';

			$mdcat_tipos = [
					'birth_place',
					'dead_at_prison',
					'end_date',
					'exile_place',
					'municipality',
					'name_surname',
					'neighborhood',
					'prison_municipality',
					'prison',
					'project',
					'fons_code',
					'pub_author',
					'pub_editor',
					'pub_year',
					'region',
					'residence_place',
					'start_date',
					'theme',
					'thesaurus',
					'title',
					'typology',
					// added 29-04-2020
					'situation',
					'situation_place',
					'nazi_camp',
					'nazi_sub_camp',
					'prisoner_number',
					// added 03-02-2021
					'gender',
					// added 10-02-2022
					'death_context',
					// added 12-05-2023
					'stolpersteine',
					'stolpersteine_date',
					'stolpersteine_place'
				];

			#
			# GLOBAL SEARCH RECORDS
			$search_options = new stdClass();
				$search_options->table 		= $global_search_table;
				$search_options->ar_fields 	= array('id','section_id','list_data','link','fields');
				$search_options->ar_fields 	= array_merge($search_options->ar_fields, $mdcat_tipos);
				# Filter
				$search_options->sql_filter = '';
				# q
				if (!empty($options->q)) {
					// is literal check. Note that quotes are escaped previously as 'Cementiri de Sant Hilari' to \'Cementiri de Sant Hilari\' .
						if (strlen($options->q)>4) {
							$first_char	= $options->q[0] . $options->q[1];
							$last_char	= $options->q[strlen($options->q)-2] . $options->q[strlen($options->q)-1];
							if ($first_char==="\'" && $last_char==="\'") {
								// literal case
								$is_literal	= true;
								// rewrite options->q
								$options->q	= str_replace("\'", '"', $options->q);
							}
						}

					# Add field
					$field_fts = "MATCH (".$field_full_data.") AGAINST ('$options->q') AS relevance ";
					array_unshift($search_options->ar_fields, $field_fts);
					# Add filter
					$search_options->sql_filter .= 'MATCH ('.$field_full_data.') AGAINST (\''.$options->q.'\' '.$options->search_modifier.')';
				}
				# sql_filter
				if ($options->sql_filter!==false) {
					if (!empty($options->q)) {
						$search_options->sql_filter .= ' AND (' . $options->sql_filter .')';
					}else{
						$search_options->sql_filter .= $options->sql_filter;
					}
				}

				if( !empty($options->q) && empty($options->order) ) {
					$options->order = "relevance DESC";
				}

				// sort by 'sort_id' always
					if (empty($options->order)) {
						// $options->order = 'sort_id ASC';
						$options->order = 'LENGTH(sort_id), sort_id ASC';
					}else{
						// $options->order .= ', sort_id ASC'; // , sort ASC
						$options->order .= ', LENGTH(sort_id), sort_id ASC';
					}

				$search_options->lang 		= $options->lang;
				$search_options->order 		= $options->order;
				$search_options->limit 		= $options->rows_per_page;
				$search_options->offset 	= $options->offset;
				$search_options->count 		= $options->count;
				$search_options->is_literal = $is_literal ?? false;
				// debug
				// error_log('++++ search_options:'.PHP_EOL. json_encode($search_options, JSON_PRETTY_PRINT));

			$rows_data = (object)web_data::get_rows_data( $search_options );
				#dump($rows_data, ' $rows_data ++ '.to_string($search_options));
				#dump($search_options, ' $search_options ++ '.to_string()); die();

			if($rows_data->result===false) {
				// $response->result	= false;
				$response->results		= false;
				// $response->msg		= 'Error. Request global_search failed. '.$rows_data->msg;
				$response->error_msg	= 'Error. Request global_search failed. '.$rows_data->msg;
				$response->error_id		= 1;

				return $response;
			}

			# Custom output
			$ar_result_final = [];
			foreach ($rows_data->result as $key => $row) {

				$link 		 = json_decode($row['link']);
				$fields_data = json_decode($row['fields']);

				$row_formated = array();

				$row_formated['id'] 	= $link->section_id; //$row['section_id'];
				$row_formated['table'] 	= $link->table;

				foreach ($fields_data as $key => $value_obj) {

					if ($value_obj->name==='descriptors') {
						$value_obj->value = !empty($value_obj->value)
							? json_decode($value_obj->value)
							: null;
					}

					$row_formated[$value_obj->name] = $value_obj->value;
				}

				$ar_result_final[] = $row_formated;
			}

			// Add vars for pagination
			// $response->page_number	= $options->page_number;
			// $response->rows_per_page	= $options->rows_per_page;
			$response->total			= $rows_data->total;
			$response->results			= $ar_result_final; //$rows_data->result;
			#$response->msg				= 'Ok. Request global_search done successfully';

			if(SHOW_DEBUG===true) {
				$response->debug = (object)[
					'time' 		=> round(microtime(1)-$start_time,3),
					'filter' 	=> $search_options->sql_filter,
					'strQuery' 	=> $rows_data->debug->strQuery ?? null
				];
			}


			return $response;
		}//end get_global_search_json



	/* NUMISDATA
	----------------------------------------------------------------------- */
		/**
		* SEARCH_TIPOS
		* @return array $ar_result
		*/
		public static function get_search_tipos($request_options) {
			#dump($request_options, ' request_options ++ '.to_string());
			$options = new stdClass();
				$options->ar_query 	= [];
				$options->limit 	= 10;
				$options->offset 	= null;
				$options->count 	= false;
				$options->total 	= false;
				$options->order 	= null;
				$options->operator 	= 'AND';
				$options->lang 		= WEB_CURRENT_LANG_CODE;
				foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

			$ar_monedas_filter = false;

			// Filter
				$filter = null;
				if ($options->ar_query) {
					$ar_filter = [];

					foreach ($options->ar_query as $key => $value_obj) {

						$current_value = addslashes($value_obj->value);
						$current_name  = $value_obj->name;

						if (!isset($value_obj->eq)) {
							$value_obj->eq = 'LIKE';
						}

						switch ($value_obj->table) {

							// FICHERO . SUBQUERY
							case 'fichero':
								$fichero_options = new stdClass();
									$fichero_options->table  	 	= 'fichero';
									$fichero_options->ar_fields  	= ['section_id'];
									$fichero_options->lang  	 	= $options->lang;
									$fichero_options->limit 		= 0;
									$fichero_options->order 		= 'section_id ASC';
									switch ($value_obj->eq) {
										case '=':
											// comma separated values case
											$c_ar_parts  = (array)explode(',', $current_value);
											$c_ar_filter = [];
											foreach ($c_ar_parts as $c_part_value) {
												$c_ar_filter[] = '`'.$value_obj->name.'` = \''. trim($c_part_value) .'\'';
											}
											if (count($c_ar_filter)>1) {
												$fichero_options->sql_filter = ' -- fichero filter '.PHP_EOL.' ('.implode(' OR ', $c_ar_filter).')';
											}else{
												$fichero_options->sql_filter = ' -- fichero filter '.PHP_EOL.' '. implode(' OR ', $c_ar_filter);
											}
											break;
										default:
											if ($value_obj->search_mode==='int') {
												$fichero_options->sql_filter = '`'.$value_obj->name."` = ".(int)$current_value;
											}else{
												$fichero_options->sql_filter = '`'.$value_obj->name."` LIKE '%".$current_value."%'";
											}
											break;
									}
								$web_data = self::get_rows_data($fichero_options);

								$monedas_ar_filter = [];
								foreach ($web_data->result as $key => $row) {
									$row = (object)$row;
									$monedas_ar_filter[] = '`monedas` LIKE \'%"'.(int)$row->section_id.'"%\''; // Filter for table tipos
									# Store for filter later
									$ar_monedas_filter[] = $row->section_id;
								}

								if (!empty($monedas_ar_filter)) {
									$ar_filter[$current_name][] = '('.implode(' OR ', $monedas_ar_filter).')';
								}
								break;

							// TS_LUGAR_DE_HALLAZGO . SUBQUERY
							case 'ts_lugar_de_hallazgo':
								$lugar_de_hallazgo_options = new stdClass();
									$lugar_de_hallazgo_options->table  	 	= $value_obj->table; //'ts_cultura';
									$lugar_de_hallazgo_options->ar_fields  	= ['term_id'];
									$lugar_de_hallazgo_options->lang  	 	= $options->lang;
									$lugar_de_hallazgo_options->limit 		= 0;

								switch ($value_obj->eq) {
									case '=':
										$lugar_de_hallazgo_options->sql_filter = '`'.$value_obj->name."` = '".$current_value.'\'';
										break;
									default:
										if ($value_obj->search_mode==='int') {
											$lugar_de_hallazgo_options->sql_filter = '`'.$value_obj->name."` = ".(int)$current_value;
										}else{
											$lugar_de_hallazgo_options->sql_filter = '`'.$value_obj->name."` LIKE '%".$current_value."%'";
										}
										break;
								}
								$web_data = self::get_rows_data($lugar_de_hallazgo_options);

								# Ahora buscamos en hallazgos, que es el que está conectado con ts_lugar_de_hallazgo
								$hallazgos_filter = [];
								foreach ($web_data->result as $lugar_de_hallazgo_value) {
									$lugar_de_hallazgo_value = (object)$lugar_de_hallazgo_value;
									$hallazgos_filter[] = '`tipologia_dato` LIKE \'%"'.$lugar_de_hallazgo_value->term_id.'"%\'';
								}
								$hallazgos_options = new stdClass();
									$hallazgos_options->table  	 	= 'hallazgos'; //'ts_cultura';
									$hallazgos_options->ar_fields  	= ['section_id'];
									$hallazgos_options->lang  	 	= $options->lang;
									$hallazgos_options->limit 		= 0;
									$hallazgos_options->sql_filter 	= '('.implode(' OR ', $hallazgos_filter).')';
								$web_data = self::get_rows_data($hallazgos_options);
									#dump($web_data, ' $web_data ++ '.to_string($hallazgos_options));

								# Ahora buscamos en fichero, que es el que está conectado con hallazgos
								$fichero_filter = [];
								foreach ($web_data->result as $hallazgos_value) {
									$hallazgos_value = (object)$hallazgos_value;
									$fichero_filter[] = '`hallazgo_dato` LIKE \'%"'.$hallazgos_value->section_id.'"%\'';
								}
								$fichero_options = new stdClass();
									$fichero_options->table  	 	= 'fichero';
									$fichero_options->ar_fields  	= ['section_id'];
									$fichero_options->lang  	 	= $options->lang;
									$fichero_options->limit 		= 0;
									$fichero_options->sql_filter 	= '('.implode(' OR ', $fichero_filter).')';
									$fichero_options->order 		= 'section_id ASC';
								$web_data = self::get_rows_data($fichero_options);
									#dump($web_data, ' $web_data ++ '.to_string($hallazgos_options));

								$monedas_ar_filter = [];
								foreach ($web_data->result as $key => $row_monedas) {
									$row_monedas = (object)$row_monedas;
									$monedas_ar_filter[] = '`monedas` LIKE \'%"'.(int)$row_monedas->section_id.'"%\''; // Filter for table tipos
									# Store for filter later
									$ar_monedas_filter[] = $row_monedas->section_id;
								}
								if(!empty($monedas_ar_filter))	$ar_filter[$current_name][] = '('.implode(' OR ', $monedas_ar_filter).')';
								break;

							// TS_CULTURA . SUBQUERY
							case 'ts_cultura':
								$cultura_options = new stdClass();
									$cultura_options->table  	 	= $value_obj->table; //'ts_cultura';
									$cultura_options->ar_fields  	= ['term_id'];
									$cultura_options->lang  	 	= $options->lang;
									$cultura_options->limit 		= 0;
									switch ($value_obj->eq) {
										case '=':
											$cultura_options->sql_filter = '`'.$value_obj->name."` = '".$current_value.'\'';
											break;
										default:
											if ($value_obj->search_mode==='int') {
												$cultura_options->sql_filter = '`'.$value_obj->name."` = ".(int)$current_value;
											}else{
												$cultura_options->sql_filter = '`'.$value_obj->name."` LIKE '%".$current_value."%'";
											}
											break;
									}
								$web_data = self::get_rows_data($cultura_options);
								foreach ($web_data->result as $key => $row) {
									$row = (object)$row;
									$ar_filter[$current_name][] = '`cultura` LIKE \'%"'.$row->term_id.'"%\''; // Filter for table tipos
								}
								break;

							// TIPOS . DIRECT
							case 'tipos':
							default:
								if ($value_obj->name==='fecha_inicio' || $value_obj->name==='fecha_fin') {

									if ($value_obj->name==='fecha_inicio') {
										$ar_field = array_filter($options->ar_query,function($element){
											return $element->name==='fecha_fin';
										});
										$ar_field = array_values($ar_field); # Reset keys
										if (!empty($ar_field) && !empty($ar_field[0]->value)) {
											# Existe valor de fecha_inicio
											$ar_filter[$current_name][] = '(CAST(`fecha_inicio` AS INT) >= '.$current_value.')';

										}else{
											$ar_filter[$current_name][] = '((`fecha_fin` IS NULL AND `fecha_inicio` = '.$current_value.') OR (CAST(`fecha_fin` AS INT) >= '.$current_value.' AND CAST(`fecha_inicio` AS INT) <= '.$current_value.'))';
										}

									}elseif ($value_obj->name==='fecha_fin') {

										$ar_field = array_filter($options->ar_query,function($element){
											return $element->name==='fecha_inicio';
										});
										$ar_field = array_values($ar_field); # Reset keys
										if (!empty($ar_field) && !empty($ar_field[0]->value)) {
											# Existe valor de fecha_inicio
											// $ar_filter[$current_name][] = '(CAST(`fecha_fin` AS INT) <= '.$current_value.')';
											$ar_filter[$current_name][] = '((`fecha_fin` IS null AND CAST(`fecha_inicio` AS INT) <= '.$current_value.') OR CAST(`fecha_fin` AS INT) <= '.$current_value.')';
										}else{
											# No hay fecha de inicio
											$ar_filter[$current_name][] = '(`fecha_fin` = '.$current_value.')';
										}
									}

								}else{
									switch ($value_obj->eq) {
										case '=':
											$ar_filter[$current_name][] = '`'.$value_obj->name."` = '".$current_value.'\'';
											break;
										case 'LIKE':
										default:
											if ($value_obj->search_mode==='int') {
												$ar_filter[$current_name][] = '`'.$value_obj->name."` = ".(int)$current_value;
											}else{
												switch ($value_obj->name) {
													case 'leyenda':
														$filter  = "CONCAT_WS(' ', `leyenda_anverso`, `leyenda_reverso`) LIKE '%".trim($current_value)."%'";
														$filter .= " AND LENGTH(CONCAT_WS('', `leyenda_anverso`, `leyenda_reverso`))>3";
														$ar_filter[$current_name][] = $filter;
														break;
													case 'diseno':
														$filter  = "CONCAT_WS(' ', `tipo_anverso`, `tipo_reverso`) LIKE '%".trim($current_value)."%'";
														$filter .= " AND LENGTH(CONCAT_WS('', `tipo_anverso`, `tipo_reverso`))>3";
														$ar_filter[$current_name][] = $filter;
														break;
													case 'denominacion':
														$ar_filter[$current_name][] = '`'.$value_obj->name."` LIKE '".$current_value."'";
														break;
													default:
														$ar_filter[$current_name][] = '`'.$value_obj->name."` LIKE '%".$current_value."%'";
														break;
												}
											}
											break;
									}//end switch ($value_obj->eq)
								}
								break;
						}//end switch ($value_obj->table)

					}//end if ($options->ar_query)

					// Overrides ar_monedas_filter when is received search for 'fichero' section_id
					$ar_fichero_section_id = array_filter($options->ar_query, function($element){
						return ($element->table === 'fichero' && $element->name === 'section_id');
					});
					if (!empty($ar_fichero_section_id)) {
						$ar_monedas_filter = []; // reset
						foreach ($options->ar_query as $value_obj) {
							$ar_monedas_filter[] = $value_obj->value;
						}
					}

					// Create final filter
						$filter = ' section_id = \'invalid_value\' ';
						$ar_filter_final = [];
						foreach ($ar_filter as $current_name => $ar_value) {
							if (!empty($ar_value)) {
								$ar_filter_final[] = '('.implode(' OR ', $ar_value).')';
							}
						}
						if (!empty($ar_filter_final)) {
							// $filter = ' -- filter final '.PHP_EOL.' ('.implode(' '.$options->operator.' ', $ar_filter_final).')';
							$filter = ' '.PHP_EOL.' ('.implode(' '.$options->operator.' ', $ar_filter_final).')';
						}

				}
				debug_log(__METHOD__." filter ".to_string($filter), 'DEBUG');
				#error_log('filter ++ : '.$filter);

			// Search
				$tipos_options = new stdClass();
					$tipos_options->table  	 	= 'tipos';
					$tipos_options->lang  	 	= $options->lang;
					$tipos_options->limit 		= (int)$options->limit;
					$tipos_options->offset 		= $options->offset;
					$tipos_options->count 		= ($options->total!==false) ? false : $options->count;
					$tipos_options->order 		= $options->order;
					$tipos_options->sql_filter 	= $filter;
					$tipos_options->resolve_portals_custom = new stdClass();
						$tipos_options->resolve_portals_custom->autoridad_dato = 'personalidades';
						$tipos_options->resolve_portals_custom->catalogo_dato  = 'catalogo';

				# Http request in php to the API
				$web_data = self::get_rows_data($tipos_options);
					#dump($web_data, ' web_data ++ '.to_string());

				// total . inject when value is already know
					if ($options->total!==false) {
						$web_data->total = $options->total;
					}

			# Convert to object all row_tipo
			$ar_tipos = [];
			foreach ((array)$web_data->result as $key => $row_tipo) {
				$ar_tipos[] = (object)$row_tipo;
			}


			$cultura_section_tipo = 'cult1';
			foreach ($ar_tipos as $key => $row_tipo) {
				if (empty($row_tipo->monedas)) continue;

				$monedas = !empty($row_tipo->monedas)
					? json_decode($row_tipo->monedas)
					: [];

				$ar_filter = [];
				foreach ((array)$monedas as $moneda_section_id) {
					if ($ar_monedas_filter!==false && false===in_array($moneda_section_id, $ar_monedas_filter)) {
						continue; # Skip
					}
					$ar_filter[] = 'section_id = '.$moneda_section_id;
				}
				$filter = '('.implode(' OR ', $ar_filter).')';

				$fichero_options = new stdClass();
					$fichero_options->table  	 	= 'fichero';
					$fichero_options->lang  	 	= $options->lang;
					$fichero_options->limit 		= 0;
					$fichero_options->sql_filter 	= $filter;
					$fichero_options->order 		= 'section_id ASC';
					$fichero_options->resolve_portals_custom = new stdClass();
						$fichero_options->resolve_portals_custom->imagen_anverso  = 'imagen';
						$fichero_options->resolve_portals_custom->imagen_reverso  = 'imagen';
						$fichero_options->resolve_portals_custom->hallazgo_dato   = 'hallazgos';
				$fichero_web_data = self::get_rows_data($fichero_options);
					#dump($fichero_web_data->result, '$fichero_web_data->result ++ '.to_string());
				# Convert to array of objects
				$fichero_ar_rows = [];
				foreach ($fichero_web_data->result as $key => $value) {
					$fichero_ar_rows[] = (object)$value;
				}

				// Add resolved values
				/*
				if (!empty($fichero_web_data->result)) {

					foreach ($fichero_ar_rows as $ckey => $cvalue) {
						if (empty($cvalue->bibliografia_dato)) {
							$fichero_ar_rows[$ckey]->publicaciones = null;
							continue;
						}

						$fichero_ar_rows[$ckey]->publicaciones = [];

						// Publicaciones add
						$bibliografia_dato = (array)json_decode($cvalue->bibliografia_dato);
						foreach ($bibliografia_dato as $cbkey => $current_biblio_id) {
							$options_biblio = new stdClass();
								$options_biblio->table  	 	= 'publicaciones';
								$options_biblio->lang  	 		= $options->lang;
								$options_biblio->sql_filter 	= 'section_id = '. (int)$current_biblio_id;
								$options_biblio->limit 			= 1;
							$rows_data_biblio = self::get_rows_data($options_biblio);

							if (!empty($rows_data_biblio->result)) {
								#$fichero_ar_rows[$ckey]->publicaciones[] = reset($rows_data_biblio->result);
								$fichero_ar_rows[$ckey]->publicaciones[] = reset($rows_data_biblio->result);
							}
						}

						// Publicaciones add
						#$bibliografia_dato  = $cvalue->bibliografia_dato;
						#$ar_biblio 			= explode(',', $bibliografia_dato);
						#	#dump($ar_biblio, ' ar_biblio ++ '.to_string());
						#foreach ($ar_biblio as $current_biblio_json) {
						#	$json_data = (array)json_decode($current_biblio_json);
						#	foreach ($json_data as $cbkey => $current_biblio_id) {
						#
						#		$options_biblio = new stdClass();
						#			$options_biblio->table  	 	= 'publicaciones';
						#			$options_biblio->lang  	 		= $options->lang;
						#			$options_biblio->sql_filter 	= 'section_id = '. (int)$current_biblio_id;
						#			$options_biblio->limit 			= 1;
						#		$rows_data_biblio = self::get_rows_data($options_biblio);
						#			#dump($rows_data_biblio->result, '$rows_data_biblio->result ++ '.to_string());
						#		if (!empty($rows_data_biblio->result)) {
						#			#$fichero_ar_rows[$ckey]->publicaciones[] = reset($rows_data_biblio->result);
						#			$fichero_ar_rows[$ckey]->publicaciones[] = reset($rows_data_biblio->result);
						#		}
						#	}
						#}

					}//end foreach ($fichero_ar_rows as $ckey => $cvalue)
					#dump($fichero_ar_rows, ' fichero_ar_rows ++ '.to_string());
				}
				*/

				// Add monedas
				$row_tipo->monedas = $fichero_ar_rows;


				// Cultura add
				if (!empty($row_tipo->cultura)) {

					$cultura_dato = (array)json_decode($row_tipo->cultura);
						#dump($cultura_dato, ' cultura_dato ++ '.to_string());
					$ar_cultura   = array_filter($cultura_dato, function($element) use($cultura_section_tipo) {
						return (strpos($element, $cultura_section_tipo)===0);
					});
					if (!empty($ar_cultura)) {
						$ar_filter_cultura = [];
						foreach ($ar_cultura as $current_cultura_term_id) {
							$ar_filter_cultura[] = 'term_id = \''.$current_cultura_term_id.'\'';
						}

						$options_cultura = new stdClass();
							$options_cultura->table  	 	= 'ts_cultura';
							$options_cultura->ar_fields  	= ['term'];
							$options_cultura->lang  	 	= $options->lang;
							$options_cultura->sql_filter 	= '('.implode(' OR ', $ar_filter_cultura).')';
							$options_cultura->limit 		= 0;
						$rows_data_cultura = self::get_rows_data($options_cultura);
							#dump($rows_data_cultura->result, '$rows_data_cultura->result ++ '.to_string());
						# Replace row content
						$row_tipo->cultura = $rows_data_cultura->result;
					}
				}

			}//end foreach ($web_data->result as $key => $row_tipo)
			#dump($web_data->result, '$web_data->result ++ '.to_string());

			$ar_result = array_values($ar_tipos);
			#$ar_result = json_encode($ar_result);
			#$ar_result = json_decode($ar_result);

			$response = new stdClass();
				$response->result 	= $ar_result;
				$response->total 	= isset($web_data->total) ? $web_data->total : null;
				$response->msg 		= 'Ok. Request done!';


			return $response;
		}//end search_tipos



	/* IMAGE
	----------------------------------------------------------------------- */
	public static function get_image_data( $request_options ) {

		$options = new stdClass();
			$options->section_id				= false;
			$options->lang 						= WEB_CURRENT_LANG_CODE;
			$options->btn_url 					= __CONTENT_BASE_URL__ . '/dedalo/inc/btn.php';
			$options->description_with_images 	= true;
			$options->description_clean 		= true;
			$options->add_notes 				= true;
			foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

		$response = new stdClass();
			$response->result = false;
			$response->msg 	  = 'Error. Request get_image_data failed';

		$image = new image( $options->section_id, $fn_options=$options );
		$image->load_data(); # Froce to load data
			#dump($image, ' image ++ '.to_string());


		$response->result = $image;
		$response->msg 	  = 'Ok. Request get_image_data done successfully';


		return $response;
	}//end get_ar_fragments_from_reel



	/**
	* GET_MENU_TREE_PLAIN
	* @param object $request_options
	* @return object $response
	*/
	public static function get_menu_tree_plain( $request_options ) : object {

		$response = new stdClass();
			$response->result 	= false;
			$response->msg 		= __METHOD__ .' Error. Request failed';

		$options = new stdClass();
			$options->table 	= null;
			$options->fields 	= ['*'];
			$options->term_id 	= null;
			$options->lang 		= null;
			foreach ($request_options as $key => $value) {if (property_exists($options, $key)) $options->$key = $value;}

		// search
			$search_options = new stdClass();
				$search_options->dedalo_get = 'records';
				$search_options->lang 		= $options->lang;
				$search_options->table 		= $options->table;
				$search_options->ar_fields 	= $options->fields;
				$search_options->sql_filter = '`parent` = \''.$options->term_id.'\'';
				$search_options->order 		= '`norder` ASC';
			$data = self::get_rows_data($search_options);

		$ar_data = $data->result;

		foreach ((array)$data->result as $key => $value) {

			$value 		= (object)$value;
			$children 	= !empty($value->children)
				? json_decode($value->children)
				: [];

			if (!empty($children)) {

				$children_options = clone $options;
					$children_options->term_id = $value->term_id;

				$current_data = self::get_menu_tree_plain($children_options);
				$ar_data = array_merge($ar_data, $current_data->result);
			}
		}

		// set response
			$response->result 	= $ar_data;
			$response->msg 		= 'OK. Request done!';


		return $response;
	}//end get_menu_tree_plain



	/**
	* GET_COMBI
	* @param object $request_options
	*	Contains a set of calls to this class
	*	Like: {
	*		ar_calls : [
	*			{ id : menu_all,
	*			  options : options
	*			}
	*		]
	*	}
	* @return object $response
	*/
	public static function get_combi( $request_options ) {

		$response = new stdClass();
			$response->result 	= false;
			$response->msg 		= __METHOD__ . ' Error. Request failed';

		$ar_response = [];

		$ar_calls = is_string($request_options->ar_calls)
			? json_decode($request_options->ar_calls)
			: $request_options->ar_calls;

		// iterate all calls
			foreach ($ar_calls as $call_obj) {

				// call to local static method
					$manager = new manager();
					$current_response = $manager->manage_request($call_obj->options);

				// inject id
					$current_response->id = $call_obj->id;

				// store response
					$ar_response[] = $current_response;
			}

		$response->result 	= $ar_response;
		$response->msg 		= __METHOD__ . ' Ok. Request done';


		return $response;
	}//end get_combi



	/**
	* GET_TABLE_THESAURUS_MAP
	* Read var table_thesaurus_map from config if exists
	* and return the value
	* @return array|null $table_thesaurus_map
	* 	Like: [
	* 		'dc1' => 'ts_chronological',
	*		'ts1' => 'ts_themes',
	*		'on1' => 'ts_onomastic'
	*	]
	*/
	public static function get_table_thesaurus_map() : ?array {
		// global from config
		global $table_thesaurus_map;

		if (!isset($table_thesaurus_map) || empty($table_thesaurus_map)) {
			return null;
		}

		return $table_thesaurus_map;
	}//end get_table_thesaurus_map



	/**
	* GET_TABLE_THESAURUS
	* Read constant TABLE_THESAURUS from config if exists
	* and return the value
	* @return string|null $table_thesaurus
	* 	Like: 'ts_chronological,ts_themes,ts_onomastic'
	*/
	public static function get_table_thesaurus() : ?string {

		// global from config
		if (defined('TABLE_THESAURUS') && !empty(TABLE_THESAURUS)) {
			return TABLE_THESAURUS;
		}

		return null;
	}//end get_table_thesaurus



	/**
	* GET_TEXT_FRAGMENT
	* Used usually to get bibliographic transcription text fragments
	* @param object $options
	* @return object $response
	*/
	public static function get_text_fragment( object $options ) : object {

		// options
			$section_id		= $options->section_id ?? ''; // E.g. '1,2,3'
			$lang			= $options->lang ?? WEB_CURRENT_LANG_CODE;
			$q				= $options->q ?? null;
			$column			= $options->column ?? 'transcription';
			$table			= $options->table ?? 'publications';
			$max_chars 		= $options->max_chars ?? 320;
			$max_occurrences = $options->max_occurrences ?? 1;

		// response
			$response = new stdClass();
				$response->result	= false;
				$response->msg		= 'Error. Request failed (get_text_fragment)';

		// check vars
			if(empty($lang) || !self::check_safe_value('lang', $lang)) {
				$response->msg = 'Error. Invalid lang: '. to_string($lang);
				return $response;
			}
			if (empty($q)) {
				$response->msg = 'Error. Empty q: '. to_string($q);
				return $response;
			}
			if (empty($section_id) || !self::check_safe_value('section_id', $section_id)) {
				$response->msg = 'Error. Invalid section_id: '. to_string($section_id);
				return $response;
			}
			if (empty($column) || !self::check_safe_value('ar_fields', $column)) {
				$response->msg = 'Error. Invalid column: '. to_string($column);
				return $response;
			}
			if (empty($table) || !self::check_safe_value('table', $table)) {
				$response->msg = 'Error. Invalid table: '. to_string($table);
				return $response;
			}
			if ((int)$max_chars < 1) {
				$response->msg = 'Error. Invalid max_chars: '. to_string($max_chars);
				return $response;
			}
			if ((int)$max_occurrences < 1) {
				$response->msg = 'Error. Invalid max_occurrences: '. to_string($max_occurrences);
				return $response;
			}

		// $safe_ar_section_id
			$safe_ar_section_id = [];
			$ar_section_id = explode(',', $section_id);
			foreach ($ar_section_id as $current_section_id) {
				$safe_ar_section_id[] = (int)trim($current_section_id);
			}

		// data. Raw text
			$s_options = new stdClass();
				$s_options->table				= $table;
				$s_options->ar_fields			= ['section_id',$column];
				$s_options->lang				= $lang;
				$s_options->sql_filter			= '`section_id` IN (' . implode(',', $safe_ar_section_id) . ')';
				$s_options->apply_postprocess	= false; // Avoid clean text on false

			$rows_data = web_data::get_rows_data( $s_options );
			if ($rows_data->result === false) {
				$response->result	= false;
				$response->msg		= 'Error. get_rows_data failed: '. $rows_data->msg;
				return $response;
			}

		// extract fragments
			$data = $rows_data->result ?? [];
			$result = [];
			foreach ($data as $row) {

				$current_text = $row[$column] ?? '';
				$current_section_id = $row['section_id'];

				if(empty($current_text)) {
					continue;
				}

				// Sanitize $q for regex usage in biblio::build_fragment
					$safe_q = preg_quote($q, '/');

				$ar_fragment = biblio::build_fragment((object)[
					'text' => $current_text,
					'search' => $safe_q,
					'max_chars' => (int)$max_chars,
					'max_occurrences' => (int)$max_occurrences
				]);

				if (empty($ar_fragment)) {
					continue;
				}

				$result[] = [
					'section_id' => $current_section_id,
					'search' 	 => $q,
					'fragments'  => $ar_fragment
				];
			}//end foreach ($data as $row)

		// response ok
			$response->result	= $result;
			$response->msg		= 'Request done successfully';

		return $response;
	}//end get_text_fragment



}//end class web_data



/*
function _mb_ereg_search_all($str, $re, $resultOrder = 0){

    // 0 mimics PREG_PATTERN_ORDER
    // 1 mimics PREG_SET_ORDER

	$matches = Array();

	mb_ereg_search_init($str, $re);
	while (($m = mb_ereg_search_regs())){
		$matches[] = $m;
	}

	if ($resultOrder == 0){
		$patternMatches = array_fill(0, count($matches), Array());
		foreach ($matches as $i => $match){
			foreach ($match as $j => $submatch){
				$patternMatches[$j][] = $submatch;
			}
		}
		$matches = $patternMatches;
	}

	return $matches;
}
*/
