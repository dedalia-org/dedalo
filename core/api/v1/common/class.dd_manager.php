<?php declare(strict_types=1);
/**
* DD_MANAGER
* Manage API web
*
*/
final class dd_manager {



	static $version = '1.0.0'; // 05-06-2019



	/**
	* __CONSTRUCT
	*/
	public function __construct() {

	}//end __construct



	/**
	* MANAGE_REQUEST
	* @param object $rqo
	* @return object $response
	*/
	final public function manage_request( object $rqo ) : object {
		$api_manager_start_time = start_time();

		// debug
			if(SHOW_DEBUG===true) {
				$text			= 'API REQUEST ' . $rqo->action;
				$text_length	= strlen($text) +1;
				$nchars			= 200;
				$line			= $text .' '. str_repeat(">", $nchars - $text_length).PHP_EOL.json_encode($rqo, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES).PHP_EOL.str_repeat("<", $nchars).PHP_EOL;
				debug_log(__METHOD__ . PHP_EOL . $line, logger::DEBUG);
			}

		// logged check
			$no_login_needed_actions = [
				'start',
				'change_lang',
				'login',
				'get_login_context',
				'install',
				'get_install_context',
				'get_environment',
				'get_ontology_update_info',
				'get_code_update_info',
				'get_server_ready_status'
			];
			if (true===in_array($rqo->action, $no_login_needed_actions)) {
				// do not check login here
			}else{
				if (login::is_logged()!==true) {

					debug_log(__METHOD__." User is not logged [action:$rqo->action]", logger::ERROR);

					// SSE process status stream. Emits a SSE formatted auth error and dies to stop client reconnections
					if ($rqo->action==='get_process_status' && ($rqo->dd_api ?? null)==='dd_utils_api') {
						dd_utils_api::get_process_status($rqo);
					}

					$response = new stdClass();
						$response->result	= false;
						$response->msg		= 'Error. user is not logged ! [action:'.$rqo->action.']';
						$response->errors[]	= 'not_logged';
					return $response;
				}
			}

		// rqo check
			if (!is_object($rqo) || !property_exists($rqo,'action')) {

				$response = new stdClass();
					$response->result	= false;
					$response->msg		= "Invalid action var (not found in rqo)";
					$response->errors[]	= 'Undefined method';

				debug_log(__METHOD__." $response->msg ".to_string(), logger::ERROR);

				return $response;
			}

		// sqo sanitize. Client SQO values reach the SQL builder: server computed SQL fragments
		// are removed and identifiers validated (see search::sanitize_client_sqo)
			if (isset($rqo->sqo) && is_object($rqo->sqo)) {
				$sqo_errors	= [];
				$safe_sqo	= search::sanitize_client_sqo($rqo->sqo, $sqo_errors);
				if ($safe_sqo===null) {

					debug_log(__METHOD__
						. " Rejected invalid client sqo " . PHP_EOL
						. ' action: ' . to_string($rqo->action) . PHP_EOL
						. ' errors: ' . to_string($sqo_errors)
						, logger::ERROR
					);

					$response = new stdClass();
						$response->result	= false;
						$response->msg		= 'Error. Invalid sqo [action:'.$rqo->action.']';
						$response->errors	= $sqo_errors;
					return $response;
				}
				$rqo->sqo = $safe_sqo;
			}

		// actions
			$dd_api_type	= $rqo->dd_api ?? 'dd_core_api';
			$dd_api			= $dd_api_type; // new $dd_api_type(); // class selected
			if ( !method_exists($dd_api, $rqo->action) ) {
				// error
				$response = new stdClass();
					$response->result	= false;
					$response->msg		= "Error. Undefined $dd_api_type method (action) : ".$rqo->action;
					$response->errors[]	= 'Undefined method';
					$response->action	= $rqo->action;
			}else{
				// success
				if($dd_api==='dd_area_maintenance_api'){
					// check access to maintenance area
					$permissions = common::get_permissions(DEDALO_AREA_MAINTENANCE_TIPO, DEDALO_AREA_MAINTENANCE_TIPO);
					if ($permissions<2) {
						$response = new stdClass();
							$response->result	= false;
							$response->msg		= 'Error. user has not permissions ! [action:'.$rqo->action.']';
							$response->errors[]	= 'permissions error';
						return $response;
					}
				}
				$response			= $dd_api::{$rqo->action}( $rqo );
				$response->action	= $rqo->action;
			}

		// debug
			if(SHOW_DEBUG===true || SHOW_DEVELOPER===true) {
				$total_time_api_exec = exec_time_unit($api_manager_start_time,'ms').' ms';
				$api_debug = new stdClass();
					$api_debug->api_exec_time	= $total_time_api_exec;
					$api_debug->memory_usage	= dd_memory_usage();
					$api_debug->rqo				= $rqo;
					$api_debug->rqo_string		= is_object($rqo)
						? json_encode($rqo, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
						: $rqo;

				if (isset($response->debug)) {
					// add to existing debug properties
					foreach ($api_debug as $key => $value) {
						$response->debug->{$key} = $value;
					}
				}else{
					// create new debug property
					$response->debug = $api_debug;
				}

				// metrics
					$metrics = [
						// permissions stats
						'Permissions',
						'--> calculated permissions for user ' . logged_user_id(),
						'--> calculated permissions_table ' . metrics::$security_permissions_table_time.' ms',
						'--> calculated security_permissions_table_count ' . metrics::$security_permissions_table_count,
						'--> security_permissions_total_time: ' . metrics::$security_permissions_total_time.' ms',
						'--> security_permissions_total_calls: '. metrics::$security_permissions_total_calls,
						// get_tools stats
						'Tools',
						'--> get_tools_total_time: ' . metrics::$get_tools_total_time.' ms',
						'--> get_tools_total_calls: '. metrics::$get_tools_total_calls,
						'--> get_tool_config_total_time: ' . metrics::$get_tool_config_total_time.' ms',
						'--> get_tool_config_total_calls: '. metrics::$get_tool_config_total_calls,
						// presets
						'Presets (request config)',
						'--> presets_total_time: '  . metrics::$presets_total_time.' ms',
						'--> presets_total_calls: ' . metrics::$presets_total_calls,
						// search stats
						'Search',
						'--> search_total_time: ' . metrics::$search_total_time.' ms',
						'--> search_total_calls: '. metrics::$search_total_calls,
						// ontology stats
						'Ontology load',
						'--> ontology_total_time: ' . metrics::$ontology_total_time.' ms',
						'--> ontology_total_calls: '. metrics::$ontology_total_calls,
						'--> ontology_total_calls_cached: '. metrics::$ontology_total_calls_cached,
						// matrix stats
						'matrix load',
						'--> matrix_total_time: ' . metrics::$matrix_total_time.' ms',
						'--> matrix_total_calls: '. metrics::$matrix_total_calls,
						// search_free stats
						'Search free',
						'--> search_free_total_time: ' . metrics::$search_free_total_time.' ms',
						'--> search_free_total_calls: '. metrics::$search_free_total_calls,
						// get_tools stats
						'section_save',
						'--> section_save_total_time: ' . metrics::$section_save_total_time.' ms',
						'--> section_save_total_calls: '. metrics::$section_save_total_calls,
						// Context
						'Context (all)',
						'--> structure_context_total_time: '  . metrics::$structure_context_total_time.' ms',
						'--> structure_context_total_calls: ' . metrics::$structure_context_total_calls,
						// data
						'Data (components)',
						'--> data_total_time: '  . metrics::$data_total_time.' ms',
						'--> data_total_calls: ' . metrics::$data_total_calls,
						// Subdatum
						// 'Subdatum',
						// '--> subdatum_total_time: ' . metrics::$subdatum_total_time.' ms',
						// '--> subdatum_total_calls: ' . metrics::$subdatum_total_calls,
						// summary
						'Summary',
						'time: ' . (
							metrics::$security_permissions_total_time +
							metrics::$search_free_total_time +
							metrics::$ontology_total_time +
							metrics::$matrix_total_time +
							metrics::$get_tools_total_time +
							metrics::$section_save_total_time
						)
					];
					debug_log(__METHOD__ . PHP_EOL
						. implode(PHP_EOL, $metrics)
						, logger::WARNING
					);


				// end line info
					$id				= $rqo->id ?? $rqo->source->tipo ?? '';
					$text			= 'API REQUEST ' . $rqo->action . ' ' . $id . ' END IN ' . $total_time_api_exec;
					$text_length	= strlen($text) +1;
					$nchars			= 200;
					$repeat 		= ($nchars - $text_length) ?? 0;
					$line			= $text .' '. $repeat .PHP_EOL;
					debug_log(__METHOD__ . PHP_EOL . $line, logger::DEBUG);
			}


		return $response;
	}//end manage_request



}//end class dd_manager
