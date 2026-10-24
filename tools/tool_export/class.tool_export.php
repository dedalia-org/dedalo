<?php declare(strict_types=1);
/**
* CLASS tool_export
*
*
*/
class tool_export extends tool_common {


	/**
	* CLASS CONSTANTS
	*/
		// int EXPORT_CHUNK_SIZE. Rows loaded per search when building the grid (bounds memory on large exports)
		const EXPORT_CHUNK_SIZE = 1000;



	/**
	* CLASS VARS
	*/
		// string data_format. Values: 'standard', 'dedalo'
		public $data_format;
		// array ar_ddo_map
		public $ar_ddo_map;
		// object sqo
		public $sqo;
		// string model
		public $model;
		// array|null ar_records.  Array of records to export (section_id) or null
		public $ar_records;



	/**
	* SETUP
	* Fix main class vars to be accessible
	* @param object options
	* @return void
	*/
	protected function setup(object $options) : void {

		// options
			$data_format	= $options->data_format;
			$ar_ddo_map		= $options->ar_ddo_map;
			$sqo			= $options->sqo;
			$model			= $options->model;
			$section_tipo	= $options->section_tipo;

		// fix data_format
			$this->data_format = $data_format;

		// fix ar_ddo_map
			$this->ar_ddo_map = $ar_ddo_map;
		// fix sqo
			// add filter from saved session if exists
			$sqo_id = section::build_sqo_id($section_tipo);
			if (!isset($sqo->filter)
				&& isset($_SESSION['dedalo']['config']['sqo'][$sqo_id])
				&& isset($_SESSION['dedalo']['config']['sqo'][$sqo_id]->filter)
				){
				// add current section filter
				$sqo->filter = $_SESSION['dedalo']['config']['sqo'][$sqo_id]->filter;
			}
			$this->sqo = $sqo;

		// fix model
			$this->model = $model;

		// fix records
			$this->ar_records = null;
	}//end setup



	/**
	* GET_EXPORT_GRID
	* Builds the grid ready to parse it in export_tool (client)
	* @see class.request_query_object.php
	* @param object options
	* Sample:
		* {
		*    "section_tipo": "oh1",
		*    "model": "section",
		*    "data_format": "standard",
		*    "ar_ddo_to_export": [
		*        {
		*            "id": "oh1_oh62_list_lg-nolan",
		*            "tipo": "oh62",
		*            "section_tipo": "oh1",
		*            "model": "component_section_id",
		*            "parent": "oh1",
		*            "lang": "lg-nolan",
		*            "mode": "search",
		*            "label": "Id",
		*            "path": [
		*                {
		*                    "section_tipo": "oh1",
		*                    "component_tipo": "oh62",
		*                    "model": "component_section_id",
		*                    "name": "Id"
		*                }
		*            ]
		*        }
		*    ],
		*    "sqo": {
		*        "section_tipo": [
		*            "oh1"
		*        ],
		*        "limit": 0,
		*        "offset": 0
		*    }
		* }
	* @return dd_grid object $result
	*/
	public static function get_export_grid(object $options) : object {

		set_time_limit ( 36000 );  // 10 hours (36000 secs)

		// response
			$response = new stdClass();
				$response->result	= false;
				$response->msg		= 'Error. Request failed ['.__FUNCTION__.']';

		// options
			$section_tipo		= $options->section_tipo ?? $options->tipo;
			$model				= $options->model ?? 'section';
			$data_format		= $options->data_format;
			$ar_ddo_to_export	= $options->ar_ddo_to_export;
			$sqo				= $options->sqo;

		// export options
			// $tool_export	= new tool_export($section_tipo, $model, $data_format, $ar_ddo_to_export, $sqo);
			$tool_export = new tool_export(null, $section_tipo);
			$tool_export->setup((object)[
				'data_format'	=> $data_format,
				'ar_ddo_map'	=> $ar_ddo_to_export,
				'sqo'			=> $sqo,
				'model'			=> $model,
				'section_tipo'	=> $section_tipo
			]);
			// ndjson stream. One JSON line per record and a final header line, flushed as built
			// no response object is returned. A missing 'end' line means the export was aborted
				if (($options->ndjson_stream ?? false) === true) {

					header('Content-Type: application/x-ndjson; charset=utf-8', true);
					header('X-Accel-Buffering: no');
					header('Cache-Control: no-cache, no-store, must-revalidate');
						header('Content-Encoding: identity'); // disable mod_deflate / gzip, it holds chunks until a threshold

						// 4KB padding line. Proxies hold the first chunk until their buffer fills.
						// The client skips whitespace-only lines
						echo str_repeat(' ', 4096)."\n";
						while (ob_get_level() > 0) {
							ob_end_flush();
						}
						flush();

					foreach ($tool_export->iterate_export_lines() as $line) {

						// client gone. Stop without the 'end' line
						if (connection_aborted()) {
							break;
						}

						$json_line = json_encode($line, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
						if ($json_line===false) {
							debug_log(__METHOD__
								." json_encode failed on export line. Stream aborted: ". json_last_error_msg()
								, logger::ERROR
							);
							break;
						}
						echo $json_line."\n";

						while (ob_get_level() > 0) {
							ob_end_flush();
						}
						flush();
					}//end foreach

					exit(0);
				}//end if ndjson_stream

			$export_grid = $tool_export->build_export_grid();

		// response OK
			$response->msg		= 'OK. Request done';
			$response->result	= $export_grid;

		return $response;
	}//end get_export_grid



	/**
	* BUILD_EXPORT_GRID
	* Legacy non-stream build. Drains iterate_export_lines() into the full array
	* @return array [header_row, ...row_objects]
	*/
	protected function build_export_grid() : array {

		$section_grid_values	= [];
		$section_grid_header	= null;

		foreach ($this->iterate_export_lines() as $line) {
			if ($line['t']==='row') {
				$section_grid_values[] = $line['row'];
			}else{
				$section_grid_header = $line['header'];
			}
		}//end foreach

		return array_merge([$section_grid_header], $section_grid_values);
	}//end build_export_grid



	/**
	* ITERATE_EXPORT_LINES
	* Builds the export grid as a stream of lines.
	* Yields ['t'=>'row', 'row'=>dd_grid_cell_object] for every record, in order,
	* and exactly one ['t'=>'end', 'header'=>section_grid_row] as the last line.
	* Only the column registry and the rows count sum survive between chunks.
	* @return Generator $lines
	*/
	public function iterate_export_lines() : Generator {

		$ar_ddo_map	= $this->ar_ddo_map;

		// full unique columns for create the head
			$ar_columns_obj	= [];
		// sum of the rows count of every record, across chunks
			$total_rows_count = 0;

		// chunked load. Search runs in pages of EXPORT_CHUNK_SIZE rows, in the client sqo order.
		// Legacy single load (get_records) is kept for portal, children_recursive and tm
		$is_chunked	= $this->is_chunked_export();
		$offset		= (int)($this->sqo->offset ?? 0);
		$max_rows	= (int)($this->sqo->limit ?? 0); // 0 means all rows
		$exported	= 0;

		do {

			if ($is_chunked) {
				$chunk_limit	= ($max_rows>0)
					? min(self::EXPORT_CHUNK_SIZE, $max_rows - $exported)
					: self::EXPORT_CHUNK_SIZE;
				$records		= $this->get_chunk_records($offset, $chunk_limit);
			}else{
				$records		= $this->get_records();
			}
			$chunk_count	= sizeof($records);
			$exported		+= $chunk_count;

			foreach ($records as $row) {

				$ar_row_value = $this->get_grid_value($ar_ddo_map, $row);
				// take the maximum number of rows (the rows can has 1, 2, 55 rows and we need the highest value, 55)
				$row_count = !empty($ar_row_value->ar_row_count)
					? max($ar_row_value->ar_row_count)
					: 0;
				// store the result to sum with the head rows
				$total_rows_count += $row_count;

				// take the columns
				$columns_count = $ar_row_value->ar_column_count;

				// current_ar_columns_obj
				$current_ar_columns_obj = $ar_row_value->ar_columns_obj;

				// get the columns position to re-order the ar_columns_obj
				// it will join the columns see if the column is a column created by the locator
				// when the component is portal inside portal, like 'photograph' inside 'identifying image' inside 'interview'.
				// 'photograph' locators will be exploded in columns not in rows and the column is identify by the section_id of the photograph
				// the final format will be: name ; surname ; name|1 ; surname|1 ; name|2 etc of the photograph
				foreach ($ar_row_value->ar_columns_obj as $current_column_obj) {
					// check if the current column exists in the full column array
					$id_obj = array_find($ar_columns_obj, function($el) use($current_column_obj){
						return ($el->id===$current_column_obj->id);
					});
					// if not exist we need add it, the columns are joined from the deep of the portals to the parents
					if($id_obj===null){
						// check if the current column_id is a locator column, else add the column_object at the end
						$current_column_path = explode('|', $current_column_obj->id);
						if(sizeof($current_column_path)>1){
							// get the last position of the column group
							$position = false;
							foreach ($ar_columns_obj as $column_key => $column_value) {
								if(isset($column_value->group) &&  $column_value->group === $current_column_obj->group){
									$position = $column_key;
								}
							}
							// if the position is set, insert the columns after the last column_object found
							// if not add the current column_object at the end
							if($position){
								array_splice($ar_columns_obj, $position+1, 0, [$current_column_obj]);
							}else{
								$ar_columns_obj[] = $current_column_obj;
							}
						}else{
							$ar_columns_obj[] = $current_column_obj;
						}
						// labels are set once on the shared column object, before its first row is streamed
						$this->set_column_labels($current_column_obj);
					}
				}//end foreach ($locator_column_obj as $column_pos => $current_column_obj)

				$row_grid = new dd_grid_cell_object();
					$row_grid->set_type('row');
					$row_grid->set_row_count($row_count);
					$row_grid->set_column_count($columns_count);
					$row_grid->set_ar_columns_obj($current_ar_columns_obj);
					// $row_grid->set_class_list($row_class_list);
					// $row_grid->set_render_label($row_render_label);
					$row_grid->set_value($ar_row_value->ar_cells);

				yield ['t'=>'row', 'row'=>$row_grid];
			}//end foreach ($records as $row)

			// release the chunk before loading the next one. Only the grid vars survive
				if ($is_chunked) {
					unset($records);
					// the static instance caches keep the records of the chunk alive (up to 1200 entries each)
					// drop them so memory stays flat. Cache misses are rebuilt on demand
					section::$ar_section_instances				= [];
					component_common::$ar_component_instances	= [];
					gc_collect_cycles();
					$offset += $chunk_limit;
				}

		} while ($is_chunked && $chunk_count===$chunk_limit && ($max_rows<=0 || $exported<$max_rows));//end do

		// build the header grid cells. The labels were set on the columns when they were registered
		$ar_head_columns			= [];
		$ar_section_columns_count	= sizeof($ar_columns_obj);
		foreach ($ar_columns_obj as $column_obj) {

			// create the grid cell of the section
				$section_grid = new dd_grid_cell_object();
					$section_grid->set_type('column');
					$section_grid->set_ar_columns_obj($column_obj); // note that only one column is expected here !
					$section_grid->set_render_label(true);
					$section_grid->set_class_list('caption section');
					$section_grid->set_cell_type('header');

			$ar_head_columns[] = $section_grid;
		}

		// dd_grid_cell_object
			$section_grid_row = new dd_grid_cell_object();
				$section_grid_row->set_type('row');
				$section_grid_row->set_value($ar_head_columns);
				// sum the total rows for the section and add the total rows to the section row
				$section_grid_row->set_row_count(1);
				$section_grid_row->set_column_count($ar_section_columns_count);

		// paged: true when the sqo was split in pages (client requests the next page). false: whole result
		yield ['t'=>'end', 'header'=>$section_grid_row, 'paged'=>$is_chunked];
	}//end iterate_export_lines



	/**
	* SET_COLUMN_LABELS
	* Sets the header labels of a column object: ar_labels, label_tipo and ar_tipos
	* @param object $column_obj
	* @return void
	*/
	protected function set_column_labels(object $column_obj) : void {

		$column_path		= explode('|', $column_obj->id);
		$column_tipos		= explode('_', $column_path[0]);
		$column_labels		= [];
		$column_tipos_len	= sizeof($column_tipos)-1;
		foreach ($column_tipos as $column_key => $column_tipo) {
			// set the column name, if the format is Dédalo use the $tipo and section_id
			// for standard format use the name
			if($this->data_format==='dedalo_raw'){
				$model_name = RecordObj_dd::get_modelo_name_by_tipo($column_tipo);
				$column_labels[] = ($model_name === 'component_section_id')
					? 'section_id'
					: $column_tipo;
			}else{
				$column_label = RecordObj_dd::get_termino_by_tipo($column_tipo, DEDALO_APPLICATION_LANG, true);
				if (empty($column_label)) {
					$column_label = $column_tipo;
				}
				$column_labels[] = (sizeof($column_path)>1 && ($column_key === $column_tipos_len))
					? $column_label.' '.(isset($column_path[1]) ? $column_path[1]+1 : '1')
					: $column_label;
			}
		}

		$column_obj->ar_labels	= $column_labels;
		$column_obj->label_tipo	= end($column_tipos);
		$column_obj->ar_tipos 	= $column_tipos;
	}//end set_column_labels



	/**
	* IS_CHUNKED_EXPORT
	* Chunked load is used for sections only. Portal, children_recursive and tm keep the single load
	* @return bool
	*/
	protected function is_chunked_export() : bool {

		return !empty($this->sqo)
			&& $this->model!=='component_portal'
			&& ($this->sqo->children_recursive ?? false)!==true
			&& !in_array($this->sqo->mode ?? null, ['tm', 'related'], true);
	}//end is_chunked_export



	/**
	* GET_CHUNK_RECORDS
	* Loads one page of the search, keeping the client sqo order.
	* Offset pages are stable because search appends 'section_id ASC' as last sort key
	* (default order when no order is set). order_custom has no such key: it is kept as sent
	* Does not store the result in ar_records
	* @param int $offset
	* @param int $limit
	* @return array $records
	*/
	protected function get_chunk_records(int $offset, int $limit) : array {

		// chunk sqo. Clone to keep this->sqo unchanged. Order is the one sent by the client
			$chunk_sqo = clone $this->sqo;
			$chunk_sqo->limit		= $limit;
			$chunk_sqo->offset		= $offset;

		// sections
			$sections = sections::get_instance(null, $chunk_sqo, $this->section_tipo);

		return $sections->get_dato();
	}//end get_chunk_records



	/**
	* GET_RECORDS
	* @return array $this->ar_records
	*/
	protected function get_records() : array {

		// empty records case
			if (!empty($this->ar_records)) {
				return $this->ar_records;
			}

		// search_options
		$section_tipo	= $this->section_tipo;
		$model			= $this->model; // section tipo like section

		switch ($model) {
			case 'component_portal':
				// To define
				break;

			default:
				// sqo
				$sqo = $this->sqo;
				if(empty($sqo)){
					debug_log(__METHOD__
						." section without sqo defined, please review the caller: $section_tipo"
						, logger::ERROR
					);
				}

	 			// sections
				$sections			= sections::get_instance(null, $sqo, $section_tipo);
				$this->ar_records	= $sections->get_dato();
				break;
		}

		return $this->ar_records;
	}//end get_records



	/**
	* GET_GRID_VALUE
	* Builds dd_grid value object
	* @param array $ar_ddo
	* @param locator $locator
	*
	* @return object $value
	*/
	protected function get_grid_value(array $ar_ddo, object $row) : object {

		$ar_cells		= [];
		$ar_row_count	= [];
		$ar_columns_obj	= [];

		$locator = new locator();
			$locator->set_section_tipo($row->section_tipo);
			$locator->set_section_id($row->section_id);

		$relations = $row->datos->relations ?? [];

		foreach ($ar_ddo as $current_ddo) {
			// children_ddo. get only the ddo that are children of the section top_tipo
			// the other ddo are sub components that will be injected to the portal as request_config->show
			$first_path	= $current_ddo->path[0];
			$ddo		= ($first_path->section_tipo===$locator->section_tipo) ? $first_path : null;

			// set the separator if the ddo has a specific separator, it will be used instead the component default separator
				// $fields_separator	= $ddo->fields_separator ?? null;
				// $records_separator	= $ddo->records_separator ?? null;
				// $format_columns		= $ddo->format_columns ?? null;
				// $class_list			= $ddo->class_list ?? null;

			// component. Create the component to get the value of the column
				$RecordObj_dd		= new RecordObj_dd($ddo->component_tipo);
				$current_lang		= $RecordObj_dd->get_traducible()==='si' ? DEDALO_DATA_LANG : DEDALO_DATA_NOLAN;
				$component_model	= RecordObj_dd::get_modelo_name_by_tipo($ddo->component_tipo, true);

				$current_component	= component_common::get_instance(
					$component_model, // string model
					$ddo->component_tipo, // string tipo
					$locator->section_id, // string|int|null section_id
					'edit', // string mode
					$current_lang, // string lang
					$locator->section_tipo, // string section_tipo
					false // bool cache
				);
				// set the locator to the new component it will be used to know; who create me.
				$current_component->set_locator($locator);
				// set the caller
				$current_component->set_caller('tool_export');
				// set the first id of the column_obj, if the component is a related component it will used to create a path of the deeper components
				$column_obj = new stdClass();
					$column_obj->id = $ddo->section_tipo.'_'.$ddo->component_tipo;
				$current_component->column_obj = $column_obj;
			// check if the component has ddo children in the path,
			// used by portals to define the path to the "text" component that has the value, it will be the last component in the chain of locators
				$sub_ddo_map = [];
				foreach ($current_ddo->path as $key => $child_ddo) {
					if($key === 0) continue;
					$new_ddo = new dd_object();
						$new_ddo->set_tipo($child_ddo->component_tipo);
						$new_ddo->set_section_tipo($child_ddo->section_tipo);
						$new_ddo->set_model($child_ddo->model);
						$new_ddo->set_parent($current_ddo->path[$key-1]->component_tipo);
						$new_ddo->set_label($child_ddo->name);
					// add ddo
					$sub_ddo_map[] = $new_ddo;
					$column_obj->id = $column_obj->id.'_'.$child_ddo->section_tipo.'_'.$child_ddo->component_tipo;
				}

				// if the component has sub_ddo, create the request_config to be injected to component
				// the request_config will be used instead the default request_config.
				if (!empty($sub_ddo_map)) {

					$show = new stdClass();
						$show->ddo_map = $sub_ddo_map;

					$request_config = new stdClass();
						$request_config->api_engine	= 'dedalo';
						$request_config->type		= 'main';
						$request_config->show		= $show;

					$current_component->request_config = [$request_config];

					// inject the locator as dato for the component
						$component_dato = array_filter($relations, function($el) use($ddo, $current_component){
							if (!isset($el->from_component_tipo)) {
								debug_log(__METHOD__
									.' Error. Ignored WRONG locator without from_component_tipo '. PHP_EOL
									.' model: ' . to_string($current_component->get_model()) . PHP_EOL
									.' tipo: ' . to_string($current_component->get_tipo()) . PHP_EOL
									.' section_tipo: ' . to_string($current_component->get_section_tipo()) . PHP_EOL
									.' section_id: ' . to_string($current_component->get_section_id()) . PHP_EOL
									.' locator: ' . to_string($el) . PHP_EOL
									// .' current_component: ' . to_string($current_component)
									, logger::ERROR
								);
								return false;
							}
							return $el->from_component_tipo===$ddo->component_tipo;
						});

						// $ar_dato = [$locator];
						$current_component->set_dato($component_dato);
				}

			// get component_value add
				switch ($this->data_format) {
					case 'dedalo_raw':
						$component_value =	$current_component->get_raw_value();
						break;

					case 'grid_value':
						$component_value = $current_component->get_grid_value($ddo);
						break;

					case 'value':
					default:
						$component_value = $current_component->get_grid_flat_value($ddo);
						break;
				}

				// $component_value = ($this->data_format==='dedalo')
				// 	? $current_component->get_raw_value()
				// 	: $current_component->get_grid_value($ddo);

			// get columns objects that the component had stored
				$sub_ar_columns_obj	= $component_value->ar_columns_obj ?? [];
				$len_items			= sizeof($sub_ar_columns_obj);

				for ($i=0; $i < $len_items; $i++) {
					$ar_columns_obj[] = $sub_ar_columns_obj[$i];
				}

			$ar_row_count[]	= $component_value->row_count ?? 1;
			$ar_cells[]		= $component_value;

		}// end foreach ($ar_children_ddo as $ddo)


		// value final object
			$value = new stdClass();
				$value->ar_row_count	= $ar_row_count;
				$value->ar_column_count	= sizeof($ar_columns_obj);
				$value->ar_columns_obj	= $ar_columns_obj;
				$value->ar_cells		= $ar_cells;


		return $value;
	}//end get_grid_value



}//end class tool_export
