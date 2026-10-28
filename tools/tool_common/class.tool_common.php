<?php declare(strict_types=1);
/**
* CLASS TOOL_COMMON
* Add basic methods for general use in tools
*/
class tool_common {



	/**
	* CLASS VARS
	*/
		public $name;
		public $config;
		// string section_tipo
		public $section_tipo;
		// string section_id
		public $section_id;



	/**
	* __CONSTRUCT
	* @param string|int $section_id
	* @param string $section_tipo
	* @return void
	*/
	public function __construct(string|int|null $section_id, string $section_tipo) {

		// set tool name as class name
		$this->name = get_called_class();

		//set
		$this->section_tipo	= $section_tipo;
		$this->section_id	= $section_id;
	}//end __construct



	/**
	* GET_JSON
	* Gets tool context
	* This function to preserve calls coherence,
	* but only is used to get context, not data.
	* @param object|null $options = null
	* @return object $json
	*/
	public function get_json( ?object $options=null ) : object {

		// options
			$get_context	= $options->get_context ?? true;
			$get_data		= $options->get_data ?? false;

		// JSON object
			$json = new stdClass();
				if (true===$get_context) {
					$json->context = [$this->get_structure_context()];
				}

		return $json;
	}//end get_json



	/**
	* GET_STRUCTURE_CONTEXT
	* Parse the tool context
	* Used when tools area loaded from different window
	* like time_machine do
	* The context data is stored in section 'dd1324' (Registered tools)
	* preparsed into the component_json 'dd1353' as JSON 'simple_tool_obj'
	* when tools are registered
	* @return dd_object $dd_object
	*/
	public function get_structure_context() : dd_object {

		// check valid name
			if ($this->name==='tool_common') {
				throw new Exception("Error. Tool name is wrong. Check your tool call using tool model", 1);
			}

		// tool name. Fixed on construct
			$name = $this->name;

		// component dato simple_tool_obj (dd1353)
			$component_tipo			= tools_register::$simple_tool_obj_component_tipo;
			$model					= RecordObj_dd::get_modelo_name_by_tipo($component_tipo,true);
			$simple_tool_component	= component_common::get_instance(
				$model,
				$component_tipo,
				$this->section_id,
				'list',
				DEDALO_DATA_NOLAN,
				$this->section_tipo
			);
			$simple_tool_obj_dato	= $simple_tool_component->get_dato();
			$tool_object			= reset($simple_tool_obj_dato);

			// sample tool object
				// {
				//   "name": "tool_transcription",
				//   "label": [
				// 	{
				// 	  "lang": "lg-cat",
				// 	  "value": "Transcripció"
				// 	}
				//   ],
				//   "labels": [
				// 	{
				// 	  "lang": "lg-spa",
				// 	  "name": "babel_transcriber",
				// 	  "value": "Babel"
				// 	}
				//   ],
				//   "version": "2.0.2",
				//   "ontology": null,
				//   "developer": [
				// 	{
				// 	  "lang": "lg-nolan",
				// 	  "value": [
				// 		"Dédalo team"
				// 	  ]
				// 	}
				//   ],
				//   "dd_version": "6.0.0",
				//   "properties": {
				// 	"open_as": "window",
				// 	"windowFeatures": null
				//   },
				//   "section_id": 26,
				//   "description": [
				// 	{
				// 	  "lang": "lg-cat",
				// 	  "value": [
				// 		"<p>Transcribir qualsevol tipus de media a text.</p>"
				// 	  ]
				// 	}
				//   ],
				//   "section_tipo": "dd1324",
				//   "always_active": false,
				//   "affected_tipos": null,
				//   "affected_models": [
				// 	"component_av",
				// 	"component_image",
				// 	"component_pdf"
				//   ],
				//   "show_in_component": true,
				//   "show_in_inspector": true,
				//   "requirement_translatable": false
				// }

			// tool_object check
			if (empty($tool_object)) {
				debug_log(__METHOD__
					. " Error. Invalid tool_object. Unable to continue !  " . PHP_EOL
					. ' model: '.to_string($model) .PHP_EOL
					. ' component_tipo: '.to_string($component_tipo) .PHP_EOL
					. ' section_tipo: '.to_string($this->section_tipo) .PHP_EOL
					. ' section_id: '.to_string($this->section_id) .PHP_EOL
					, logger::ERROR
				);
			}

		// label. (JSON list) Try match current lang else use the first lang value
			$ar_labels = $tool_object->label ?? [];
			$tool_label_object = array_find($ar_labels, function($el){
				return $el->lang===DEDALO_APPLICATION_LANG;
			});
			$tool_label = is_object($tool_label_object) && isset($tool_label_object->value)
				? $tool_label_object->value
				: (is_object($ar_labels[0])
					? ($ar_labels[0]->value ?? null)
					: null);
			if (!is_string($tool_label)) {
				debug_log(__METHOD__
					. " Fixed invalid tool label " . PHP_EOL
					. ' tool_label: ' . to_string($tool_label) . PHP_EOL
					. ' tool_object: ' . to_string($tool_object) . PHP_EOL
					, logger::ERROR
				);
				$tool_label = $name;
			}

		// developer
			$developer_data = array_find($tool_object->developer ?? [], function($el){
				return $el->lang===DEDALO_DATA_NOLAN;
			});
			$developer = is_object($developer_data) && !empty($developer_data->value)
				? $developer_data->value[0]
				: null;

		// description. (text_area) Try match current lang else use the first lang value
			$ar_description = $tool_object->description ?? [];
			$tool_description_object = array_find($ar_description, function($el){
				return $el->lang===DEDALO_APPLICATION_LANG;
			});
			$description = is_object($tool_description_object) && !empty($tool_description_object->value)
				? $tool_description_object->value[0]
				: (is_object($ar_description[0]->value)
					? ($ar_description[0]->value ?? null)
					: null);

		// labels. take care of empty objects like '{}'
			$labels = [];
			if(!empty($tool_object->labels) && !empty($tool_object->labels[0])) {

				// get the lang to be used to get the labels
					$current_lang = lang::get_label_lang( DEDALO_APPLICATION_LANG );

				// add label with lang fallback
				foreach ($tool_object->labels as $current_label_value) {

					$label_name = $current_label_value->name;
					if(!isset($labels[$label_name])) {

						$all_langs_label = array_filter((array)$tool_object->labels, function($el) use($label_name) {
							return $el->name===$label_name;
						});
						foreach ($all_langs_label as $item) {
							if (!isset($item->lang)) {
								// ignore
								debug_log(__METHOD__
									. " Ignored item without expected property 'lang'. Check this tool definition labels " . PHP_EOL
									. ' item: ' . to_string($item) .PHP_EOL
									. ' all_langs_label: ' . to_string($all_langs_label) .PHP_EOL
									. ' tool_object: ' . to_string($tool_object)
									, logger::ERROR
								);
							}

							if ($item->lang===$current_lang) {
								$labels[$label_name] = $item;
								continue 2;
							}
						}

						// fallback lang. Get the first one as fallback value setting as lang current lang
						$fallback_label = reset($all_langs_label);
						$fallback_label->lang = DEDALO_APPLICATION_LANG; // inject current lang to prevent find errors
						$labels[$label_name] = $fallback_label;
					}
				}

				// remove keys
				$labels = array_values($labels);
			}

		// properties
			$properties = empty($tool_object->properties)
				? null
				: $tool_object->properties; // object|array

		// config. Add if exists config data for current tool
			$ar_config		= tools_register::get_all_config_tool_client();
			$config_data	= array_find($ar_config, function($el) use($name) {
				return $el->name===$name;
			});
			// fallback to default config
			if(!is_object($config_data) || empty($config_data->config)){
				$ar_config		= tools_register::get_all_default_config_tool_client();
				$config_data	= array_find($ar_config, function($el) use($name) {
					return $el->name===$name;
				});
			}
			// config
			$config = is_object($config_data)
				? $config_data->config
				: null;

		// lang
			$lang = DEDALO_APPLICATION_LANG;

		// css
			$css = (object)[
				'url' => DEDALO_TOOLS_URL . '/' . $name . '/css/' .$name. '.css'
			];

		// icon
			$icon = DEDALO_TOOLS_URL . '/' . $name . '/img/icon.svg';

		// context
			$dd_object = new dd_object((object)[
				'name'				=> $name,
				'label'				=> $tool_label,
				'developer'			=> $developer,
				'tipo'				=> $component_tipo,
				'section_tipo'		=> $tool_object->section_tipo,
				'model'				=> $name,
				'lang'				=> $lang,
				'mode'				=> 'edit',
				'properties'		=> $properties,
				'css'				=> $css,
				'icon'				=> $icon,
				'labels'			=> $labels,
				'description'		=> $description,
				'show_in_inspector'	=> $tool_object->show_in_inspector ?? null,
				'show_in_component'	=> $tool_object->show_in_component ?? null,
				'config'			=> $config
			]);


		return $dd_object;
	}//end get_structure_context



	/**
	* CREATE_TOOL_SIMPLE_CONTEXT
	* Parse a tool context from a simple_tool_object
	* @param object $tool_object (simple_tool_object from tool record JSON component dd1353)
	* @param object|null $tool_config = null (from properties)
	* @param string|null $tipo = null
	* @param string|null $section_tipo = null
	* @return dd_object $tool_simple_context
	*/
	public static function create_tool_simple_context( object $tool_object, ?object $tool_config=null, ?string $tipo=null, ?string $section_tipo=null ) : dd_object {

		// old way. (!) Unification with context in progress..
			// label. (JSON list) Try match current lang else use the first lang value
				$ar_labels = $tool_object->label ?? [];
				$tool_label_object = array_find($ar_labels, function($el){
					return $el->lang===DEDALO_APPLICATION_LANG;
				});
				$tool_label = is_object($tool_label_object) && isset($tool_label_object->value)
					? $tool_label_object->value
					: (is_object($ar_labels[0])
						? $ar_labels[0]->value ?? null
						: null);
				// fallback label to tool name
				if(empty($tool_label)) {
					$tool_label = $tool_object->name ?? 'Unknown';
				}

			// css
				$css = (object)[
					'url' => DEDALO_TOOLS_URL . '/' . $tool_object->name . '/css/' .$tool_object->name. '.css'
				];

			// icon
				$icon = DEDALO_TOOLS_URL . '/' . $tool_object->name . '/img/icon.svg';

			// developer
				$developer = isset($tool_object->developer[0])
					? ($tool_object->developer[0]->value[0] ?? null)
					: null;

			// context
				$tool_simple_context = new dd_object((object)[
					'name'				=> $tool_object->name,
					'label'				=> $tool_label,
					'developer'			=> $developer,
					// 'tipo'			=> $component_tipo,
					'section_tipo'		=> $tool_object->section_tipo,
					// 'section_id'		=> $tool_object->section_id,
					'model'				=> $tool_object->name,
					// 'lang'			=> $lang,
					'mode'				=> 'edit',
					'properties'		=> $tool_object->properties,
					'css'				=> $css,
					'icon'				=> $icon,
					// 'labels'			=> $labels,
					// 'description'	=> $description,
					'show_in_inspector'	=> $tool_object->show_in_inspector ?? null,
					'show_in_component'	=> $tool_object->show_in_component ?? null,
					// 'config'			=> !empty($config_data) ? $config_data->config : null
				]);

		// new way. (!) Unification with context in progress..
			// // short vars
			// 	$section_id		= $tool_object->section_id;
			// 	$section_tipo	= $tool_object->section_tipo;
			// 	$model			= $tool_object->name;

			// // tool construct and get JSON context
			// 	$element = new $model($section_id, $section_tipo);
			// 	// element JSON
			// 	$get_json_options = new stdClass();
			// 		$get_json_options->get_context	= true;
			// 		$get_json_options->get_data		= false;
			// 	$element_json = $element->get_json($get_json_options);
			// 	$context = $element_json->context;

			// // tool_simple_context
			// 	$tool_simple_context = $context;
			// 		// dump($tool_simple_context, ' ++ ============================== tool_simple_context ++ '.to_string($section_tipo.'-'.$section_id));
			// 		// dump($context, ' ++ ============================== context ++ '.to_string($section_tipo.'-'.$section_id));


		// tool_config add
			if (!empty($tool_config)) {
				// parse and resolve ddo_map self
					if (isset($tool_config->ddo_map)) {
						$tool_config->ddo_map = array_map(function($el) use($tipo, $section_tipo, $tool_config){

							if (!is_object($el)) {
								debug_log(__METHOD__
									. " Error. Bad ddo_map item" . PHP_EOL
									. ' el: ' . to_string($el) . PHP_EOL
									. ' tool_config->ddo_map: ' . to_string($tool_config->ddo_map)
									, logger::ERROR
								);
							}

							if ($el->tipo==='self') {
								$el->tipo = $tipo;
							}
							if ($el->section_tipo==='self') {
								$el->section_tipo = $section_tipo;
							}
							if (!isset($el->model)) {
								$el->model = RecordObj_dd::get_modelo_name_by_tipo($el->tipo,true);
							}
							// check if the component is translatable and set to true or false
							$el->translatable = RecordObj_dd::get_translatable($el->tipo);

							$el->label = RecordObj_dd::get_termino_by_tipo($el->tipo, DEDALO_APPLICATION_LANG, true, true);

							return $el;
						}, $tool_config->ddo_map);
					}

				// set parsed tool_config
					$tool_simple_context->tool_config = $tool_config;
			}//end if (!empty($tool_config))



		return $tool_simple_context;
	}//end create_tool_simple_context



	/**
	* GET_STRUCTURE_CONTEXT_SIMPLE
	* @param int $permissions = 0
	* @param bool $add_request_config = false
	* @return dd_object $full_ddo
	*/
	public function get_structure_context_simple(int $permissions=0, bool $add_request_config=false) : dd_object {

		// call general method
		$full_ddo = $this->get_structure_context();


		return $full_ddo;
	}//end get_structure_context_simple



	/**
	* GET_REGISTERED_TOOLS
	* Get the full or filtered list data of current registered tools in database
	* @return array $registered_tools
	*/
	public static function get_all_registered_tools() : array {

		$registered_tools = [];

		// cache
			$use_cache = true;
			if ($use_cache===true) {

				// static
					static $all_registered_tools_cache;
					if (isset($all_registered_tools_cache)) {
						return $all_registered_tools_cache;
					}

				// cache file (moved to tool_common::get_user_tools)
					// $file_cache = dd_cache::cache_from_file((object)[
					// 	'file_name'	=> 'cache_registered_tools.json'
					// ]);
					// if (!empty($file_cache)) {
					// 	// read from file encoded JSON
					// 	$registered_tools = json_handler::decode($file_cache);

					// 	// static save value
					// 	$all_registered_tools_cache = $registered_tools;

					// 	return $registered_tools;
					// }
			}

		// all_registered_tools_records
			static $all_registered_tools_records;
			if(!isset($all_registered_tools_records)) {
				$all_registered_tools_records = tool_common::get_active_tools();
			}
		// get all tools config sections
			$ar_config = tools_register::get_all_config_tool_client();

		// get the simple_tool_object
			foreach ($all_registered_tools_records as $record) {

				$section		= section::get_instance($record->section_id, $record->section_tipo);
				$section_dato	= $record->datos;
				$section->set_dato($section_dato);

				// simple tool object 'dd1353'
				$component_tipo	= 'dd1353';
				$model			= RecordObj_dd::get_modelo_name_by_tipo($component_tipo,true);
				$component		= component_common::get_instance(
					$model,
					$component_tipo,
					$record->section_id,
					'list',
					DEDALO_DATA_NOLAN,
					$record->section_tipo
				);
				$dato = $component->get_dato();
				if (empty($dato)) {
					debug_log(__METHOD__
						." Ignored empty dato of  $record->section_tipo - $component_tipo - $record->section_id " . PHP_EOL
						.' model: ' . to_string($model)
						, logger::WARNING
					);
					continue;
				}

				$current_value = reset($dato);
				if(isset($ar_tools) && !in_array($current_value->name, $ar_tools)){
					continue;
				}

				// append config
					$current_config	= array_find($ar_config, function($el) use($current_value) {
						return $el->name===$current_value->name;
					});
					// $current_config = array_filter($ar_config, function($item) use($current_value){
					// 	if($item->name === $current_value->name) {
					// 		return $item;
					// 	}
					// });

					if(!is_object($current_config)){
						$ar_config		= tools_register::get_all_default_config_tool_client();
						$current_config	= array_find($ar_config, function($el) use($current_value) {
							return is_object($el) && is_object($current_value) && $el->name===$current_value->name;
						});
					}

					if(!is_object($current_config)){
						debug_log(__METHOD__
							. " Ignored bad config " . PHP_EOL
							. to_string($current_config)
							, logger::ERROR
						);
						continue;
					}

					$current_value->config = is_object($current_config)
						? $current_config->config
						: null;

				$registered_tools[] = $current_value;
			}//end foreach ($all_registered_tools_records as $record)

		// cache
			if ($use_cache===true) {
				// static
					$all_registered_tools_cache = $registered_tools;

				// cache file (moved to tool_common::get_user_tools)
					// dd_cache::cache_to_file((object)[
					// 	'data'		=> $registered_tools,
					// 	'file_name'	=> 'cache_registered_tools.json'
					// ]);
			}


		return $registered_tools;
	}//end get_all_registered_tools



	/**
	* GET_ACTIVE_TOOLS
	* Search all active tools in registered tools section
	* @return array $active_tools
	*/
	public static function get_active_tools() : array {

		// get all active and registered tools
			$sqo_tool_active = json_decode('{
				"section_tipo": "'.DEDALO_REGISTER_TOOLS_SECTION_TIPO.'",
				"limit": 0,
				"filter": {
					"$and": [
						{
							"q": {"section_id":"1","section_tipo":"dd64","type":"dd151","from_component_tipo":"dd1354"},
							"q_operator": null,
							"path": [
								{
									"section_tipo": "'.DEDALO_REGISTER_TOOLS_SECTION_TIPO.'",
									"component_tipo": "dd1354",
									"model": "component_radio_button",
									"name": "Active"
								}
							]
						}
					]
				},
				"full_count": false
			}');
			$search	= search::get_instance($sqo_tool_active);
			$result	= $search->search();

		$active_tools = $result->ar_records;


		return $active_tools;
	}//end get_active_tools



	/**
	* GET_ACTIVE_TOOL_NAMES
	* Get active tools in tool section and return only the names as: ["tool_lang", "tool_time_machine"]
	* Used in update code to get the tool list from the master
	* @return array $tool_names
	*/
	public static function get_active_tool_names() {

		$active_tools = tool_common::get_active_tools();

		$tool_names = [];
		foreach ($active_tools as $current_tool_row) {

			$section_tipo	= $current_tool_row->section_tipo;
			$section_id		= $current_tool_row->section_id;

		// name
		// create the component to get his value
			$component_tipo	= tools_register::$tipo_tool_name; // 'dd1326';
			$model			= RecordObj_dd::get_modelo_name_by_tipo($component_tipo,true);
			$component		= component_common::get_instance(
				$model,
				$component_tipo,
				$section_id,
				'list',
				DEDALO_DATA_NOLAN,
				$section_tipo
			);
			// get value as 'tool_lang'
			$name = $component->get_value();

			// check it, if nothing isset continue to next one.
			if( empty($name) ){
				continue;
			}

			$tool_names[] = $name;
		}


		return $tool_names;
	}//end get_active_tool_names



	/**
	* GET_CONFIG
	* Get given tool config if isset
	* @param string $tool_name
	* @return object|null $config
	*/
	public static function get_config(string $tool_name) : ?object {

		// debug
			if(SHOW_DEBUG===true) {
				$start_time=start_time();
				// metrics
				metrics::$get_tool_config_total_calls++;
			}

		// cache
			static $cache_config_tool = [];
			if( array_key_exists($tool_name, $cache_config_tool) ){
				return $cache_config_tool[$tool_name];
			}

		// get all tools config sections
			$ar_config = tools_register::get_all_config_tool();

		// select current from all tool config
			$config = array_find($ar_config, function($el) use($tool_name) {
				return $el->name===$tool_name;
			});

			if(!is_object($config)){
				// get all tools config sections
				$ar_config = tools_register::get_all_default_config();
				$config = array_find($ar_config, function($el) use($tool_name) {
					return $el->name===$tool_name;
				});

				// no config is found at all
				if(!is_object($config)){
					//cache
					$cache_config_tool[$tool_name] = null;

					return null;
				}
			}

		// cache. save the result into the cache
			$cache_config_tool[$tool_name] = $config;

		// debug
			if(SHOW_DEBUG===true) {
				// metrics
				$total_time_ms = exec_time_unit($start_time, 'ms');
				metrics::$get_tool_config_total_time += $total_time_ms;
			}


		return $config;
	}//end get_config



	/**
	* READ_FILES
	* Read files from directory and return all files array filtered by extension
	* @return array $ar_data
	*/
	public static function read_files(string $dir, array $valid_extensions=['csv']) : array {

		$ar_data = array();

		// scan directory
			try {
				$root = is_dir($dir)
					? scandir($dir)
					: null;
			} catch (Exception $e) {
				debug_log(__METHOD__
					." Error on read dir: ".to_string($dir)
					, logger::ERROR
				);
			}

		// error on read the dir or empty result
			if (!$root) {
				return $ar_data; // empty array
			}

		// sort files in natural order
			natsort($root);

		// iterate and get only files. Skip others
			foreach($root as $value) {

				// Skip non valid extensions
					$file_parts = pathinfo($value);
					if(!isset($file_parts['extension']) || !in_array(strtolower($file_parts['extension']), $valid_extensions)) {
						debug_log(__METHOD__." Skipped file: $value", logger::DEBUG);
						continue;
					}

				// Case file
					if(is_file("$dir/$value")) {
						$ar_data[] = $value;
					}

				// Case dir recursive ($recursive=true)
					// if($recursive) foreach(self::find_all_files("$dir/$value", $recursive) as $value) {
					// 	$ar_data[] = $value;
					// }
			}

		// SORT ARRAY (By custom core function build_sorter)
			// usort($ar_data, build_sorter('numero_recurso'));


		return $ar_data;
	}//end read_files



	/**
	* READ_CSV_FILE_AS_ARRAY
	* Reads given csv file as array of data.
	* Note that expected encoding is UTF-8 and
	* the locale settings are taken into account by php fgetcsv function.
	* If LC_CTYPE is e.g. en_US.UTF-8, files in one-byte encodings may be read wrongly by fgetcsv.
	* When file encoding is different from UTF-8, a conversion try will be made.
	* @param string $file
	* @param bool $skip_header
	* @param string $csv_delimiter
	* @param string $enclosure
	* @param string $escape
	*
	* @return array $csv_array
	* 	An empty array is returned when something wrong happens, like when the file doesn't exist
	*/
	public static function read_csv_file_as_array(string $file, bool $skip_header=false, string $csv_delimiter=';', string $enclosure='"', string $escape='"') : array {

		// file not found case
			if(!file_exists($file)) {
				debug_log(__METHOD__
					." File not found " . PHP_EOL
					.' file: '.to_string($file)
					, logger::ERROR
				);
				return [];
			}

		// auto_detect_line_endings
			$is_php81 = (version_compare(PHP_VERSION, '8.1.0') >= 0);
			if (!$is_php81) {
				ini_set('auto_detect_line_endings', true);
			}

		// open file in read mode
			$f = fopen($file, "r");

		// skip UTF-8 BOM before parsing (in-line it breaks blank line detection and quoted first cell)
			if (fread($f, 3) !== pack('H*','EFBBBF')) {
				rewind($f);
			}

		// read contents line by line and store data
			$csv_array			= array();
			$convert_to_utf8	= false;
			$i=0;
			while (($line = fgetcsv($f, 0, $csv_delimiter, $enclosure, $escape)) !== false) {

				// skip blank lines (fgetcsv returns [null])
					if ($line === [null]) {
						continue;
					}

				// skip header case
					if ($skip_header && $i===0) {
						$i++;
						continue;
					}

				// safe array type
					if (!is_array($line)) {
						$line = [$line];
					}

				// encoding check . Only UFT-8 is valid. Another encodings will be converted to UTF-8
					// $sample = reset($line);
					$sample = is_array($line) ? implode(', ', $line) : (string)$line;
					if ($convert_to_utf8===true || !mb_check_encoding($sample, 'UTF-8')) {
						foreach ($line as $key => $current_value) {
							// $line[$key] = utf8_encode($current_value);
							// replacement for PHP8.2 (https://php.watch/versions/8.2/utf8_encode-utf8_decode-deprecated)
							// $line[$key] = mb_convert_encoding($current_value, 'UTF-8', 'ISO-8859-1'); // ISO-8859-1 to UTF-8
							$line[$key] = mb_convert_encoding($current_value, 'UTF-8', mb_list_encodings()); // Any encoding to UTF-8
						}
						$convert_to_utf8 = true; // prevent to check more than once
					}

				// iterate line cells (columns from split text line by $csv_delimiter)
					foreach ($line as $cell) {
						$csv_array[$i][] = trim($cell);
					}

				$i++;
			}//end while

		// close file a end
			fclose($f);

		// auto_detect_line_endings
			if (!$is_php81) {
				ini_set('auto_detect_line_endings', false);
			}


		return $csv_array;
	}//end read_csv_file_as_array



	/**
	* CALL_COMPONENT_METHOD (NOT USED AT THE MOMENT)
	* Call component method
	* @param object $options
	* @return object $response
	*/
	public static function call_component_method(object $options) : object {

		// Working here... (!)
		throw new Exception("Error Processing Request", 1);


		$response = new stdClass();
			$response->result	= false;
			$response->msg		= 'Error. Request failed ['.__FUNCTION__.']';

		// options
			$tipo				= $options->tipo ?? null;
			$section_id			= $options->section_id ?? null;
			$section_tipo		= $options->section_tipo ?? null;
			$method				= $options->method ?? null;
			$method_arguments	= $options->method_arguments ?? null;

		// component
			$model		= RecordObj_dd::get_modelo_name_by_tipo($tipo,true);
			$component	= component_common::get_instance(
				$model,
				$tipo,
				$section_id,
				'list',
				DEDALO_DATA_NOLAN,
				$section_tipo
			);
			if (!empty($method) && method_exists($component, $method)) {

				// call component
					$call_result = $component->{$method}($method_arguments);

				// response
					$response->result = isset($call_result->result)
						? $call_result->result
						: $call_result;
					$response->msg = isset($call_result->msg)
						? $call_result->msg
						: 'Request done ['.__FUNCTION__.']';

			}else{

				// response error
					$response->result	= false;
					$response->msg		.= '. Method does not exists: '.$method .' in '.$model;
			}


		return $response;
	}//end call_component_method



	/**
	* GET_USER_TOOLS
	* Get filtered user authorized tools
	* (Filtered by profiles security_tools data)
	* @param int $user_id
	* @return array $user_tools
	*/
	public static function get_user_tools(int $user_id) : array {

		// default value (empty array)
			$user_tools = [];

		// empty or zero user case
			if (empty($user_id)) {
				return $user_tools;
			}

		// cache
			$use_cache = true;
			if ($use_cache===true) {

				// static
					static $user_tools_cache;
					if (isset($user_tools_cache[$user_id])) {
						return $user_tools_cache[$user_id];
					}

				// cache file
					$cache_file_name = tools_register::get_cache_user_tools_file_name(); //	like 'cache_user_tools.json'
					$file_cache = dd_cache::cache_from_file((object)[
						'file_name'	=> $cache_file_name
					]);
					if (!empty($file_cache)) {
						// read from file encoded JSON
						$user_tools = json_handler::decode($file_cache);

						// static save value
						$user_tools_cache[$user_id] = $user_tools;

						return $user_tools;
					}
			}

		// all unfiltered tools
			$registered_tools = tool_common::get_all_registered_tools();

		// user_tools
			if ($user_id==DEDALO_SUPERUSER) {

				$user_tools = $registered_tools;

			}else{

				// tool permissions (DEDALO_COMPONENT_SECURITY_TOOLS_PROFILES_TIPO)
					$security_tools_dato = (function() use($user_id) {

						$user_profile = security::get_user_profile($user_id);
						if (empty($user_profile)) {
							return []; // empty array
						}
						$user_profile_id		= (int)$user_profile->section_id;
						$security_tools_model	= RecordObj_dd::get_modelo_name_by_tipo(DEDALO_COMPONENT_SECURITY_TOOLS_PROFILES_TIPO, true);
						$component				= component_common::get_instance(
							$security_tools_model,
							DEDALO_COMPONENT_SECURITY_TOOLS_PROFILES_TIPO,
							$user_profile_id,
							'list',
							DEDALO_DATA_NOLAN,
							DEDALO_SECTION_PROFILES_TIPO
						);
						// dato
						return $component->get_dato();
					})();

				// allowed tools
					$ar_allowed_id = array_map(function($el){
						return $el->section_id;
					}, $security_tools_dato);

				// filter user authorized tools
					foreach ($registered_tools as $tool) {

						if( (isset($tool->always_active) && $tool->always_active===true) ||
							 in_array($tool->section_id, $ar_allowed_id)
							) {
							$user_tools[] = $tool;
						}
					}
			}

		// tool_config
		// Add resolved tool_config property to cached file
		// Will be used later to get resolved user tools config from cache
		// for example in get_structure_context or get_buttons_context
			array_map(function($tool){
				$tool->tool_config = tool_common::get_config($tool->name);
			}, $user_tools);

		// cache
			if ($use_cache===true) {
				// static
					$user_tools_cache[$user_id] = $user_tools;

				// cache file
					// cache file
					dd_cache::cache_to_file((object)[
						'data'		=> $user_tools,
						'file_name'	=> $cache_file_name
					]);
			}


		return $user_tools;
	}//end get_user_tools



	/**
	* GET_TOOL_CONFIG
	* 	Get the specific tool config in registered tools or tool configuration
	*	when the tool has a specific properties in the register or in his configuration records
	*	overwrite the ontology properties with them
	*	flow of overwrite: the most specific overwrite the most generic
	*		configuration -> configuration register -> ontology
	*	1 if the configuration isset use it
	*	2 else get the configuration in register, if isset use it
	*	3 else get the ontology properties
	*
	* @param object $options
	* {
	* 	tool_name: string as 'tool_lang'
	* 	tipo: string as 'dd47'
	* 	section_tipo: string as 'rsc167'
	* }
	* @param object|null $tool_config = null
	* 	Normally, is get from tools cache file, else will be calculated
	* @return object|null $tool_config
	*/
	public static function get_tool_configuration( object $options, ?object $tool_config=null ) : ?object {

		$tool_name		= $options->tool_name;
		$tipo			= $options->tipo;
		$section_tipo	= $options->section_tipo;

		// get the config, get_config check is the specific configuration isset
		// else get the configuration in register record
			$tool_configuration = $tool_config ?? tool_common::get_config($tool_name);

			// check if has a properties and tool_config definition
			if( isset($tool_configuration->config)
				&& isset($tool_configuration->config->properties)
				&& isset($tool_configuration->config->properties->tool_config) ){
				// tool config is an array with specific object for tipo and section_tipo
				// (that need to match with the button_import definition and his section)
				// find the definition that match with current section
				$ar_tool_config = $tool_configuration->config->properties->tool_config ?? [];

				$tool_config = array_find($ar_tool_config, function($item) use($section_tipo, $tipo) {
					return $item->section_tipo === $section_tipo && $item->tipo === $tipo;
				});

				return $tool_config;
			}


		return null;
	}//end get_tool_config



}//end class tool_common
